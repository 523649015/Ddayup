#include "HMDaoUnrealCaptureModule.h"

#include "Camera/CameraActor.h"
#include "Camera/CameraComponent.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Components/SkeletalMeshComponent.h"
#include "Containers/Ticker.h"
#include "Editor.h"
#include "Engine/SceneCapture2D.h"
#include "Engine/TextureRenderTarget2D.h"
#include "TextureResource.h"
#include "EngineUtils.h"
#include "Framework/Application/SlateApplication.h"
#include "Widgets/SWindow.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformProcess.h"
#include "HttpModule.h"
#include "GenericPlatform/GenericPlatformHttp.h"
#include "ImageUtils.h"
#include "IImageWrapper.h"
#include "IImageWrapperModule.h"
#include "IWebSocket.h"
#include "ISequencer.h"
#include "LevelSequence.h"
#include "LevelSequenceActor.h"
#include "LevelSequencePlayer.h"
#include "LevelEditorSequencerIntegration.h"
#include "LevelEditorViewport.h"
#include "Math/Range.h"
#include "Math/UnrealMathUtility.h"
#include "Misc/Base64.h"
#include "Misc/CommandLine.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "MovieScene.h"
#include "MovieSceneBinding.h"
#include "MovieScenePossessable.h"
#include "MovieSceneSection.h"
#include "MovieSceneSpawnable.h"
#include "RenderingThread.h"
#include "Sections/MovieSceneCameraCutSection.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Tracks/MovieSceneCameraCutTrack.h"
#include "MovieSceneTrack.h"
#include "UObject/UObjectIterator.h"
#include "WebSocketsModule.h"

namespace
{
// WS 地址可配置：默认本机 8792，可由环境变量 HMDAO_WS_URL 覆盖（上云时指向 wss://<域名>/ws/dcc/unreal?role=plugin）。
// 注意：owner 参数由后端从连接意图文件/鉴权解析，插件侧保持 role=plugin 即可。
FString HMDaoUnrealWsUrl = TEXT("ws://127.0.0.1:8792/ws/dcc/unreal?role=plugin");
// 云端多用户隔离：前端 Connect 时把当前登录 token 写入连接意图文件，插件读取后附加到 WS URL，
// 后端据此解析 userId 作为 owner 分桶，避免串流他人引擎。本机部署时为空，后端回退 local 桶。
FString HMDaoConnectToken;
void ResolveHMDaoUnrealWsUrl()
{
    FString EnvUrl = FPlatformMisc::GetEnvironmentVariable(TEXT("HMDAO_WS_URL"));
    if (!EnvUrl.IsEmpty())
    {
        HMDaoUnrealWsUrl = EnvUrl;
        UE_LOG(LogTemp, Log, TEXT("HMDao Unreal Capture: WS URL from HMDAO_WS_URL = %s"), *HMDaoUnrealWsUrl);
    }
    else
    {
        UE_LOG(LogTemp, Log, TEXT("HMDao Unreal Capture: WS URL default = %s"), *HMDaoUnrealWsUrl);
    }
}
constexpr float HMDaoBootstrapPollIntervalSeconds = 1.0f;
constexpr float HMDaoRuntimeTickIntervalSeconds = 1.0f / 60.0f;
constexpr double HMDaoSocketStaleTimeoutSeconds = 8.0;
constexpr double HMDaoSocketStaleTimeoutRecordingSeconds = 45.0;
constexpr double HMDaoConnectIntentPollIntervalSeconds = 1.0;
constexpr double HMDaoBridgeReadyGraceSeconds = 1.5;
constexpr const TCHAR* HMDaoConnectRequestFileName = TEXT("hmdao_unreal_capture.request.json");
constexpr int32 HMDaoMaxPreviewStreamFps = 60;
constexpr int32 HMDaoMaxRecordingFps = 240;
bool IsLocalLoopbackBridgeUrl(const FString& Url)
{
    return Url.StartsWith(TEXT("ws://127.0.0.1"))
        || Url.StartsWith(TEXT("wss://127.0.0.1"))
        || Url.StartsWith(TEXT("ws://localhost"))
        || Url.StartsWith(TEXT("wss://localhost"))
        || Url.StartsWith(TEXT("ws://[::1]"))
        || Url.StartsWith(TEXT("wss://[::1]"));
}

void PrimeWebSocketsForLocalBridge()
{
    const bool bWebSocketsAlreadyLoaded = FModuleManager::Get().IsModuleLoaded(TEXT("WebSockets"));
    FHttpModule& HttpModule = FHttpModule::Get();
    const FString OriginalProxyAddress = HttpModule.GetProxyAddress();

    if (bWebSocketsAlreadyLoaded)
    {
        if (!OriginalProxyAddress.IsEmpty() && IsLocalLoopbackBridgeUrl(HMDaoUnrealWsUrl))
        {
            UE_LOG(LogTemp, Warning, TEXT("HMDao Unreal Capture: WebSockets already loaded with proxy '%s'; local bridge may still be proxied"), *OriginalProxyAddress);
        }
        return;
    }

    const bool bShouldBypassProxyForLocalBridge = !OriginalProxyAddress.IsEmpty() && IsLocalLoopbackBridgeUrl(HMDaoUnrealWsUrl);
    ON_SCOPE_EXIT
    {
        if (bShouldBypassProxyForLocalBridge)
        {
            HttpModule.SetProxyAddress(OriginalProxyAddress);
            UE_LOG(LogTemp, Log, TEXT("HMDao Unreal Capture: restored HTTP proxy after WebSockets init"));
        }
    };

    if (bShouldBypassProxyForLocalBridge)
    {
        UE_LOG(LogTemp, Log, TEXT("HMDao Unreal Capture: priming WebSockets for local bridge without proxy '%s'"), *OriginalProxyAddress);
        HttpModule.SetProxyAddress(FString());
    }

    FWebSocketsModule::Get();
}

FString ToJson(const TSharedRef<FJsonObject>& Object)
{
    FString Out;
    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
    FJsonSerializer::Serialize(Object, Writer);
    return Out;
}

void SetString(TSharedRef<FJsonObject> Object, const TCHAR* Key, const FString& Value)
{
    Object->SetStringField(Key, Value);
}

int32 ReadIntField(const TSharedPtr<FJsonObject>& Json, const TCHAR* Key, int32 Fallback)
{
    double Value = static_cast<double>(Fallback);
    if (Json.IsValid() && Json->TryGetNumberField(Key, Value) && FMath::IsFinite(Value))
    {
        return FMath::RoundToInt(Value);
    }
    return Fallback;
}

bool HasNumberField(const TSharedPtr<FJsonObject>& Json, const TCHAR* Key)
{
    double Value = 0.0;
    return Json.IsValid() && Json->TryGetNumberField(Key, Value) && FMath::IsFinite(Value);
}

FString ReadStringField(const TSharedPtr<FJsonObject>& Json, const TCHAR* Key, const FString& Fallback = FString())
{
    FString Value;
    if (Json.IsValid() && Json->TryGetStringField(Key, Value) && !Value.IsEmpty())
    {
        return Value;
    }
    return Fallback;
}

void ResolveImageFormat(const FString& RequestedFormat, EImageFormat& OutFormat, FString& OutMimeType)
{
    const FString Normalized = RequestedFormat.TrimStartAndEnd().ToLower();
    if (Normalized == TEXT("png"))
    {
        OutFormat = EImageFormat::PNG;
        OutMimeType = TEXT("image/png");
        return;
    }

    OutFormat = EImageFormat::JPEG;
    OutMimeType = TEXT("image/jpeg");
}

FString NormalizeRecordingOutputFormat(const FString& RequestedFormat)
{
    const FString Normalized = RequestedFormat.TrimStartAndEnd().ToLower();
    return Normalized == TEXT("webm") ? TEXT("webm") : TEXT("mp4");
}

FString ResolveRecordingMimeType(const FString& RequestedFormat)
{
    return NormalizeRecordingOutputFormat(RequestedFormat) == TEXT("webm") ? TEXT("video/webm") : TEXT("video/mp4");
}

FString QuoteProcessArgument(const FString& Value)
{
    FString Escaped = Value;
    Escaped.ReplaceInline(TEXT("\""), TEXT("\\\""));
    return FString::Printf(TEXT("\"%s\""), *Escaped);
}

bool SaveBytesToFile(const TArray64<uint8>& Bytes, const FString& FilePath)
{
    if (Bytes.Num() <= 0)
    {
        return false;
    }

    TArray<uint8> Output;
    Output.Append(Bytes.GetData(), static_cast<int32>(Bytes.Num()));
    return FFileHelper::SaveArrayToFile(Output, *FilePath);
}

bool EncodePixels(const TArray<FColor>& Pixels, int32 Width, int32 Height, const FString& RequestedFormat, int32 Quality, TArray64<uint8>& OutBytes, FString& OutMimeType)
{
    OutBytes.Reset();
    if (Pixels.Num() == 0 || Width <= 0 || Height <= 0)
    {
        return false;
    }

    EImageFormat ImageFormat = EImageFormat::JPEG;
    ResolveImageFormat(RequestedFormat, ImageFormat, OutMimeType);

    IImageWrapperModule& ImageWrapperModule = FModuleManager::LoadModuleChecked<IImageWrapperModule>(TEXT("ImageWrapper"));
    const TSharedPtr<IImageWrapper> ImageWrapper = ImageWrapperModule.CreateImageWrapper(ImageFormat);
    if (!ImageWrapper.IsValid())
    {
        return false;
    }

    if (!ImageWrapper->SetRaw(Pixels.GetData(), Pixels.Num() * sizeof(FColor), Width, Height, ERGBFormat::BGRA, 8))
    {
        return false;
    }

    const int32 SafeQuality = FMath::Clamp(Quality, 1, 100);
    OutBytes = ImageWrapper->GetCompressed(SafeQuality);
    return OutBytes.Num() > 0;
}

bool EncodePixelsToBase64(const TArray<FColor>& Pixels, int32 Width, int32 Height, const FString& RequestedFormat, int32 Quality, FString& OutPayload, FString& OutMimeType)
{
    TArray64<uint8> Encoded;
    if (!EncodePixels(Pixels, Width, Height, RequestedFormat, Quality, Encoded, OutMimeType))
    {
        return false;
    }

    OutPayload = FBase64::Encode(Encoded.GetData(), Encoded.Num());
    return !OutPayload.IsEmpty();
}

bool LooksLikeNearBlackFrame(const TArray<FColor>& Pixels)
{
    if (Pixels.Num() <= 0)
    {
        return true;
    }

    const int32 SampleStep = FMath::Max(1, Pixels.Num() / 4096);
    int32 SampleCount = 0;
    int32 BrightSampleCount = 0;
    int64 TotalBrightness = 0;

    for (int32 Index = 0; Index < Pixels.Num(); Index += SampleStep)
    {
        const FColor& Pixel = Pixels[Index];
        const int32 Brightness = static_cast<int32>(Pixel.R) + static_cast<int32>(Pixel.G) + static_cast<int32>(Pixel.B);
        TotalBrightness += Brightness;
        if (Pixel.R > 10 || Pixel.G > 10 || Pixel.B > 10)
        {
            BrightSampleCount += 1;
        }
        SampleCount += 1;
    }

    if (SampleCount <= 0)
    {
        return true;
    }

    const double AverageChannelBrightness = static_cast<double>(TotalBrightness) / static_cast<double>(SampleCount * 3);
    const double BrightRatio = static_cast<double>(BrightSampleCount) / static_cast<double>(SampleCount);
    return AverageChannelBrightness < 1.5 && BrightRatio < 0.003;
}

FString BuildCameraLabel(AActor* Actor, UCameraComponent* CameraComponent)
{
    if (!Actor || !CameraComponent)
    {
        return TEXT("Editor Viewport");
    }

    FString ActorLabel = Actor->GetActorLabel();
    if (ActorLabel.IsEmpty())
    {
        ActorLabel = Actor->GetName();
    }

    const FString ComponentName = CameraComponent->GetName();
    if (!ComponentName.IsEmpty() && ComponentName != TEXT("CameraComponent") && ComponentName != Actor->GetName())
    {
        return FString::Printf(TEXT("%s / %s"), *ActorLabel, *ComponentName);
    }

    return ActorLabel;
}

FString DescribeTransform(const FTransform& Transform)
{
    const FVector Location = Transform.GetLocation();
    const FRotator Rotation = Transform.Rotator();
    const FVector Scale = Transform.GetScale3D();
    return FString::Printf(
        TEXT("loc=(%.2f,%.2f,%.2f) rot=(%.2f,%.2f,%.2f) scale=(%.2f,%.2f,%.2f)"),
        Location.X, Location.Y, Location.Z,
        Rotation.Pitch, Rotation.Yaw, Rotation.Roll,
        Scale.X, Scale.Y, Scale.Z);
}

bool IsUsableFrameRate(const FFrameRate& Rate)
{
    return Rate.Numerator > 0 && Rate.Denominator > 0;
}

FFrameRate ChooseUsableFrameRate(const FFrameRate& Preferred, const FFrameRate& Fallback, const FFrameRate& DefaultRate = FFrameRate(30, 1))
{
    if (IsUsableFrameRate(Preferred))
    {
        return Preferred;
    }

    if (IsUsableFrameRate(Fallback))
    {
        return Fallback;
    }

    return DefaultRate;
}

// Returns the display name of a MovieScene binding without using the deprecated
// FMovieSceneBinding::GetName(). Prefers the possessable, then the spawnable name.
FString GetMovieSceneBindingName(const UMovieScene* MovieScene, const FMovieSceneBinding& Binding)
{
    if (!MovieScene)
    {
        return FString();
    }

    const FGuid Guid = Binding.GetObjectGuid();
    UMovieScene* MutableMovieScene = const_cast<UMovieScene*>(MovieScene);
    if (const FMovieScenePossessable* Possessable = MutableMovieScene->FindPossessable(Guid))
    {
        return Possessable->GetName();
    }
    if (const FMovieSceneSpawnable* Spawnable = MutableMovieScene->FindSpawnable(Guid))
    {
        return Spawnable->GetName();
    }
    return FString();
}

bool TryTransformFrameTime(const FFrameTime& SourceTime, const FFrameRate& SourceRate, const FFrameRate& DestinationRate, FFrameTime& OutTime)
{
    if (!IsUsableFrameRate(SourceRate) || !IsUsableFrameRate(DestinationRate))
    {
        return false;
    }

    OutTime = FFrameRate::TransformTime(SourceTime, SourceRate, DestinationRate);
    return true;
}

void ApplyCameraViewToCapture(USceneCaptureComponent2D* CaptureComponent, UCameraComponent* CameraComponent)
{
    if (!CaptureComponent || !CameraComponent)
    {
        return;
    }

    FMinimalViewInfo ViewInfo;
    CameraComponent->GetCameraView(0.0f, ViewInfo);
    CaptureComponent->SetWorldLocationAndRotation(ViewInfo.Location, ViewInfo.Rotation);
    CaptureComponent->FOVAngle = ViewInfo.FOV;
    CaptureComponent->ProjectionType = ViewInfo.ProjectionMode;
    CaptureComponent->OrthoWidth = ViewInfo.OrthoWidth;
    CaptureComponent->PostProcessSettings = ViewInfo.PostProcessSettings;

    // The capture must render the camera's post-processing pass (depth of field,
    // exposure, etc.) exactly like the editor viewport does. UCineCameraComponent
    // already bakes its cinematic depth-of-field (focal distance, f-stop, sensor
    // width, blade count, ...) into ViewInfo.PostProcessSettings via GetCameraView,
    // so copying those settings and forcing the capture to fully honor them reproduces
    // the in-engine DOF/focus look in both screenshots and recordings.
    CaptureComponent->PostProcessBlendWeight = 1.0f;
    CaptureComponent->ShowFlags.SetPostProcessing(true);
    CaptureComponent->ShowFlags.SetDepthOfField(true);

    // WYSIWYG guarantee: the capture must reproduce EVERYTHING the editor camera viewport shows,
    // including screen-space effects. By default a SceneCapture2D does NOT render reflections /
    // SSR / Lumen reflections / ambient occlusion / translucency the same way the viewport does,
    // which would make the recording MISS hair reflections, fluid specular, particle glow, etc.
    // Force these show flags on so the captured frame is pixel-faithful to what the user sees.
    CaptureComponent->ShowFlags.SetReflectionEnvironment(true);   // planar / environment reflections
    CaptureComponent->ShowFlags.SetScreenSpaceReflections(true);  // SSR
    CaptureComponent->ShowFlags.SetAmbientOcclusion(true);        // GTAO / SSAO
    CaptureComponent->ShowFlags.SetTranslucency(true);            // particles, fluids, glass
    CaptureComponent->ShowFlags.SetLighting(true);
    CaptureComponent->ShowFlags.SetMaterials(true);
    CaptureComponent->ShowFlags.SetEditor(false);                 // use the game/PIE look, not editor tint
    CaptureComponent->ShowFlags.SetGame(true);
    CaptureComponent->ShowFlags.SetPostProcessing(true);
}

FFrameTime BuildDisplayFrameTime(double DisplayFrameValue)
{
    const int32 WholeFrame = FMath::FloorToInt(DisplayFrameValue);
    const float SubFrame = static_cast<float>(DisplayFrameValue - static_cast<double>(WholeFrame));
    return FFrameTime(FFrameNumber(WholeFrame), SubFrame);
}

FString ResolveBindingDisplayName(const UMovieScene* MovieScene, const FMovieSceneBinding& Binding)
{
    if (!MovieScene)
    {
        return FString();
    }

    const FGuid BindingId = Binding.GetObjectGuid();
    if (const FMovieScenePossessable* Possessable = const_cast<UMovieScene*>(MovieScene)->FindPossessable(BindingId))
    {
        return Possessable->GetName();
    }

    if (const FMovieSceneSpawnable* Spawnable = const_cast<UMovieScene*>(MovieScene)->FindSpawnable(BindingId))
    {
        return Spawnable->GetName();
    }

    return FString();
}

bool BindingTargetsSelection(const UMovieScene* MovieScene, const FMovieSceneBinding& Binding, const FString& SelectedCameraId, const FString& SelectedCameraName)
{
    const FGuid BindingId = Binding.GetObjectGuid();
    const FString BindingIdString = BindingId.IsValid() ? BindingId.ToString(EGuidFormats::DigitsWithHyphens) : FString();
    if (!SelectedCameraId.IsEmpty() && !BindingIdString.IsEmpty() && BindingIdString.Contains(SelectedCameraId))
    {
        return true;
    }

    const FString BindingName = ResolveBindingDisplayName(MovieScene, Binding);
    if (!SelectedCameraName.IsEmpty() && !BindingName.IsEmpty() &&
        (BindingName.Equals(SelectedCameraName, ESearchCase::IgnoreCase) || BindingName.Contains(SelectedCameraName)))
    {
        return true;
    }

    return false;
}

bool SequenceLikelyTargetsCamera(const UMovieScene* MovieScene, const FString& SelectedCameraId, const FString& SelectedCameraName)
{
    if (!MovieScene)
    {
        return false;
    }

    if (SelectedCameraId.IsEmpty() && SelectedCameraName.IsEmpty())
    {
        return false;
    }

    const TArray<FMovieSceneBinding>& Bindings = static_cast<const UMovieScene*>(MovieScene)->GetBindings();
    for (const FMovieSceneBinding& Binding : Bindings)
    {
        if (BindingTargetsSelection(MovieScene, Binding, SelectedCameraId, SelectedCameraName))
        {
            return true;
        }
    }

    return false;
}

bool TryGetInclusiveFrameBounds(const TRange<FFrameNumber>& Range, FFrameNumber& OutLowerTick, FFrameNumber& OutUpperTickInclusive)
{
    if (!Range.HasLowerBound() || !Range.HasUpperBound())
    {
        return false;
    }

    OutLowerTick = Range.GetLowerBoundValue();
    const FFrameNumber UpperTickExclusive = Range.GetUpperBoundValue();
    OutUpperTickInclusive = FFrameNumber(FMath::Max(OutLowerTick.Value, UpperTickExclusive.Value - 1));
    return true;
}

void ExpandFrameBounds(const TRange<FFrameNumber>& Range, bool& bInOutHasBounds, FFrameNumber& InOutLowerTick, FFrameNumber& InOutUpperTickInclusive)
{
    FFrameNumber LowerTick = 0;
    FFrameNumber UpperTickInclusive = 0;
    if (!TryGetInclusiveFrameBounds(Range, LowerTick, UpperTickInclusive))
    {
        return;
    }

    if (!bInOutHasBounds)
    {
        InOutLowerTick = LowerTick;
        InOutUpperTickInclusive = UpperTickInclusive;
        bInOutHasBounds = true;
        return;
    }

    InOutLowerTick = FFrameNumber(FMath::Min(InOutLowerTick.Value, LowerTick.Value));
    InOutUpperTickInclusive = FFrameNumber(FMath::Max(InOutUpperTickInclusive.Value, UpperTickInclusive.Value));
}

void ExpandTrackBounds(const UMovieSceneTrack* Track, bool& bInOutHasBounds, FFrameNumber& InOutLowerTick, FFrameNumber& InOutUpperTickInclusive)
{
    if (!Track)
    {
        return;
    }

    const TArray<UMovieSceneSection*>& Sections = Track->GetAllSections();
    for (const UMovieSceneSection* Section : Sections)
    {
        if (!Section || !Section->IsActive())
        {
            continue;
        }

        ExpandFrameBounds(Section->GetRange(), bInOutHasBounds, InOutLowerTick, InOutUpperTickInclusive);
    }
}

bool TryGetEffectiveMovieSceneFrameBounds(
    UMovieScene* MovieScene,
    const FString& SelectedCameraId,
    const FString& SelectedCameraName,
    FFrameNumber& OutLowerTick,
    FFrameNumber& OutUpperTickInclusive)
{
    if (!MovieScene)
    {
        return false;
    }

    const UMovieScene* ConstMovieScene = MovieScene;
    bool bHasBounds = false;
    FFrameNumber LowerTick = 0;
    FFrameNumber UpperTickInclusive = 0;

    // Expand a binding AND every ancestor possessable. A camera that has no keyframes
    // of its own can still move because a parent transform animates it; the effective
    // range must therefore include the parent's tracks, otherwise parent-driven motion
    // gets trimmed off and the recording stops early.
    auto ExpandBindingTree = [&](const FGuid& RootBindingId)
    {
        FGuid CurrentId = RootBindingId;
        int32 Guard = 0;
        while (CurrentId.IsValid() && Guard++ < 32)
        {
            if (const FMovieSceneBinding* Binding = ConstMovieScene->FindBinding(CurrentId))
            {
                for (const UMovieSceneTrack* Track : Binding->GetTracks())
                {
                    ExpandTrackBounds(Track, bHasBounds, LowerTick, UpperTickInclusive);
                }
            }

            const FMovieScenePossessable* Possessable = MovieScene->FindPossessable(CurrentId);
            CurrentId = Possessable ? Possessable->GetParent() : FGuid();
        }
    };

    if (UMovieSceneCameraCutTrack* CameraCutTrack = Cast<UMovieSceneCameraCutTrack>(MovieScene->GetCameraCutTrack()))
    {
        ExpandTrackBounds(CameraCutTrack, bHasBounds, LowerTick, UpperTickInclusive);
    }

    // Always expand the selected camera's own tracks and its parent chain so that
    // parent-driven range is never truncated by the camera cut track bounds above.
    if (!SelectedCameraId.IsEmpty() || !SelectedCameraName.IsEmpty())
    {
        const TArray<FMovieSceneBinding>& Bindings = ConstMovieScene->GetBindings();
        for (const FMovieSceneBinding& Binding : Bindings)
        {
            if (!BindingTargetsSelection(MovieScene, Binding, SelectedCameraId, SelectedCameraName))
            {
                continue;
            }

            ExpandBindingTree(Binding.GetObjectGuid());
        }
    }

    if (!bHasBounds)
    {
        const TArray<FMovieSceneBinding>& Bindings = ConstMovieScene->GetBindings();
        for (const FMovieSceneBinding& Binding : Bindings)
        {
            ExpandBindingTree(Binding.GetObjectGuid());
        }

        for (const UMovieSceneTrack* Track : ConstMovieScene->GetTracks())
        {
            ExpandTrackBounds(Track, bHasBounds, LowerTick, UpperTickInclusive);
        }
    }

    ExpandFrameBounds(MovieScene->GetPlaybackRange(), bHasBounds, LowerTick, UpperTickInclusive);

    if (!bHasBounds)
    {
        return false;
    }

    OutLowerTick = LowerTick;
    OutUpperTickInclusive = UpperTickInclusive;
    return true;
}

bool HasVisibleInteractiveEditorWindow(const bool bAllowHiddenWindow)
{
#if WITH_EDITOR
    if (!FSlateApplication::IsInitialized())
    {
        return false;
    }

    // When an explicit connect intent exists (either the -HMDaoConnect launch flag OR
    // the on-demand connect request file HMDao writes when the user clicks Connect), we
    // must not require the editor window to be visibly focused. This is what makes the
    // bridge connect reliably no matter how the editor was launched (Epic Launcher,
    // desktop shortcut, double-click .uproject) and whether its window is minimized or
    // sitting behind other windows.
    const bool bAllowHiddenWindowForStartupConnect = bAllowHiddenWindow
        || FParse::Param(FCommandLine::Get(), TEXT("HMDaoConnect"));
    TArray<TSharedRef<SWindow>> Windows = FSlateApplication::Get().GetTopLevelWindows();
    for (const TSharedRef<SWindow>& Window : Windows)
    {
        if (!Window->IsRegularWindow())
        {
            continue;
        }

        if (!bAllowHiddenWindowForStartupConnect && (!Window->IsVisible() || Window->IsWindowMinimized()))
        {
            continue;
        }

        if (!Window->GetNativeWindow().IsValid())
        {
            continue;
        }

        return true;
    }
#endif
    return false;
}
}

void FHMDaoUnrealCaptureModule::StartupModule()
{
    UE_LOG(LogTemp, Log, TEXT("HMDao Unreal Capture: StartupModule"));
    ResolveHMDaoUnrealWsUrl();
    PrimeWebSocketsForLocalBridge();
    bConnectRequested = FParse::Param(FCommandLine::Get(), TEXT("HMDaoConnect"));
    if (bConnectRequested)
    {
        UE_LOG(LogTemp, Log, TEXT("HMDao Unreal Capture: startup connect flag detected"));
        StartRuntimeTicker();
        return;
    }
    StartBootstrapTicker();
}

void FHMDaoUnrealCaptureModule::ShutdownModule()
{
    StopBootstrapTicker();
    StopRuntimeTicker();
    StopRecording();
    if (ASceneCapture2D* CaptureActorInstance = CaptureActor.Get())
    {
        CaptureActorInstance->Destroy();
    }
    CaptureActor.Reset();
    RenderTarget.Reset();
    Disconnect();
}

bool FHMDaoUnrealCaptureModule::TickBootstrap(float)
{
    if (RefreshConnectIntent() && bConnectRequested)
    {
        StartRuntimeTicker();
        return false;
    }
    return true;
}

bool FHMDaoUnrealCaptureModule::TickRuntime(float)
{
    const bool bSessionActive = Socket.IsValid() || bSocketConnecting || Recording.bActive || bPreviewStreamingEnabled;
    if (!bConnectRequested && !bSessionActive)
    {
        StartBootstrapTicker();
        return false;
    }

    const double Now = FPlatformTime::Seconds();
    RefreshConnectIntent();

    const bool bEditorReadyForBridge = IsEditorReadyForBridge();
    if (bEditorReadyForBridge)
    {
        if (EditorReadySinceAt <= 0.0)
        {
            EditorReadySinceAt = Now;
        }
    }
    else
    {
        EditorReadySinceAt = 0.0;
    }

    const bool bEditorReadyStableForBridge = ShouldAttemptConnect();
    if (!bEditorReadyStableForBridge && !Recording.bActive)
    {
        return true;
    }

    TickRecording(Now);

    if (!Socket.IsValid() || (!Socket->IsConnected() && !bSocketConnecting))
    {
        if (bEditorReadyStableForBridge && Now - LastReconnectAt >= 2.0)
        {
            LastReconnectAt = Now;
            Connect();
        }
        return true;
    }

    const double ActiveSocketStaleTimeoutSeconds = Recording.bActive
        ? HMDaoSocketStaleTimeoutRecordingSeconds
        : HMDaoSocketStaleTimeoutSeconds;

    if (LastPongAt > 0.0 && Now - LastPongAt >= ActiveSocketStaleTimeoutSeconds)
    {
        UE_LOG(
            LogTemp,
            Warning,
            TEXT("HMDao Unreal Capture: WebSocket stale for %.2fs (timeout %.2fs), forcing reconnect"),
            Now - LastPongAt,
            ActiveSocketStaleTimeoutSeconds);
        LastReconnectAt = Now;
        Disconnect();
        return true;
    }

    if (Now - LastPingAt >= 3.0)
    {
        LastPingAt = Now;
        const TSharedRef<FJsonObject> Ping = MakeShared<FJsonObject>();
        SetString(Ping, TEXT("type"), TEXT("ping"));
        Ping->SetNumberField(TEXT("ts"), FDateTime::UtcNow().ToUnixTimestamp());
        Socket->Send(ToJson(Ping));
    }

    const bool bShouldSendPreviewFrames = Recording.bActive || bPreviewStreamingEnabled;
    if (bShouldSendPreviewFrames)
    {
        const int32 TargetFps = Recording.bActive ? FMath::Clamp(Recording.Fps, 1, HMDaoMaxRecordingFps) : FMath::Clamp(PreviewFps, 1, HMDaoMaxPreviewStreamFps);
        if (Now - LastFrameSentAt >= (1.0 / static_cast<double>(TargetFps)))
        {
            LastFrameSentAt = Now;
            SendFrame();
        }
    }

    // Keep the frontend's sequence/camera presence flags fresh so the node can warn
    // before recording even if the user opens a Level Sequence after connecting.
    // Re-report the timeline at most ~2x/sec and only when the reported state changes.
    if (Now - LastTimelineReportAt >= 0.5)
    {
        const bool bHasSequenceNow = FindPreferredEditorSequencer().IsValid();
        UWorld* World = GetEditorWorld();
        const bool bHasCameraNow = GatherSceneCameras(World).Num() > 0;
        if (bHasSequenceNow != bLastReportedHasSequence || bHasCameraNow != bLastReportedHasCamera)
        {
            bLastReportedHasSequence = bHasSequenceNow;
            bLastReportedHasCamera = bHasCameraNow;
            SendTimeline();
        }
        LastTimelineReportAt = Now;
    }

    return true;
}

void FHMDaoUnrealCaptureModule::StartBootstrapTicker()
{
    if (BootstrapTickHandle.IsValid())
    {
        return;
    }

    BootstrapTickHandle = FTSTicker::GetCoreTicker().AddTicker(
        FTickerDelegate::CreateRaw(this, &FHMDaoUnrealCaptureModule::TickBootstrap),
        HMDaoBootstrapPollIntervalSeconds);
}

void FHMDaoUnrealCaptureModule::StopBootstrapTicker()
{
    if (!BootstrapTickHandle.IsValid())
    {
        return;
    }

    FTSTicker::GetCoreTicker().RemoveTicker(BootstrapTickHandle);
    BootstrapTickHandle.Reset();
}

void FHMDaoUnrealCaptureModule::StartRuntimeTicker()
{
    StopBootstrapTicker();
    if (RuntimeTickHandle.IsValid())
    {
        return;
    }

    RuntimeTickHandle = FTSTicker::GetCoreTicker().AddTicker(
        FTickerDelegate::CreateRaw(this, &FHMDaoUnrealCaptureModule::TickRuntime),
        HMDaoRuntimeTickIntervalSeconds);
}

void FHMDaoUnrealCaptureModule::StopRuntimeTicker()
{
    if (!RuntimeTickHandle.IsValid())
    {
        EditorReadySinceAt = 0.0;
        return;
    }

    FTSTicker::GetCoreTicker().RemoveTicker(RuntimeTickHandle);
    RuntimeTickHandle.Reset();
    EditorReadySinceAt = 0.0;
}

bool FHMDaoUnrealCaptureModule::IsEditorReadyForBridge() const
{
#if WITH_EDITOR
    if (!GEditor || !FSlateApplication::IsInitialized())
    {
        return false;
    }

    const UWorld* EditorWorld = GEditor->GetEditorWorldContext().World();
    if (!IsValid(EditorWorld))
    {
        return false;
    }

    const bool bViewportReady = GEditor->GetActiveViewport() != nullptr
        || GCurrentLevelEditingViewportClient != nullptr
        || GLastKeyLevelEditingViewportClient != nullptr;
    const bool bExplicitConnectRequested = bConnectRequested
        || FParse::Param(FCommandLine::Get(), TEXT("HMDaoConnect"));
    if (bExplicitConnectRequested)
    {
        return HasVisibleInteractiveEditorWindow(true);
    }
    return bViewportReady && HasVisibleInteractiveEditorWindow(false);
#else
    return false;
#endif
}

bool FHMDaoUnrealCaptureModule::ShouldAttemptConnect() const
{
#if WITH_EDITOR
    if (!bConnectRequested || !IsEditorReadyForBridge() || EditorReadySinceAt <= 0.0)
    {
        return false;
    }

    return FPlatformTime::Seconds() - EditorReadySinceAt >= HMDaoBridgeReadyGraceSeconds;
#else
    return false;
#endif
}

bool FHMDaoUnrealCaptureModule::RefreshConnectIntent()
{
    if (bConnectRequested)
    {
        return true;
    }

    const double Now = FPlatformTime::Seconds();
    if (LastConnectIntentCheckAt > 0.0 && Now - LastConnectIntentCheckAt < HMDaoConnectIntentPollIntervalSeconds)
    {
        return bConnectRequested;
    }
    LastConnectIntentCheckAt = Now;

    FString PayloadText;
    const FString RequestFile = GetConnectRequestFilePath();
    if (!FPaths::FileExists(RequestFile) || !FFileHelper::LoadFileToString(PayloadText, *RequestFile))
    {
        return bConnectRequested;
    }

    TSharedPtr<FJsonObject> Json;
    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(PayloadText);
    if (!FJsonSerializer::Deserialize(Reader, Json) || !Json.IsValid())
    {
        UE_LOG(LogTemp, Warning, TEXT("HMDao Unreal Capture: invalid connect request file, deleting %s"), *RequestFile);
        ClearConnectRequestFile();
        return bConnectRequested;
    }

    const FString RequestedProject = ReadStringField(Json, TEXT("projectPath"));
    const FString CurrentProject = FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath());
    double RequestedPidValue = 0.0;
    Json->TryGetNumberField(TEXT("targetPid"), RequestedPidValue);
    const uint32 RequestedPid = RequestedPidValue > 0.0 ? static_cast<uint32>(RequestedPidValue) : 0u;
    const uint32 CurrentPid = FPlatformProcess::GetCurrentProcessId();
    const bool bProjectPathMatches = RequestedProject.IsEmpty() || CurrentProject.IsEmpty()
        || FPaths::IsSamePath(FPaths::ConvertRelativePathToFull(RequestedProject), CurrentProject);
    const bool bPidMatchesCurrentProcess = RequestedPid > 0u && RequestedPid == CurrentPid;
    if (!bProjectPathMatches)
    {
        if (bPidMatchesCurrentProcess)
        {
            UE_LOG(LogTemp, Warning, TEXT("HMDao Unreal Capture: accepting connect request for current pid %u despite project path mismatch requested='%s' current='%s'"), CurrentPid, *RequestedProject, *CurrentProject);
        }
        else
        {
            UE_LOG(LogTemp, Warning, TEXT("HMDao Unreal Capture: ignoring connect request for different project requested='%s' current='%s' requestedPid=%u currentPid=%u"), *RequestedProject, *CurrentProject, RequestedPid, CurrentPid);
            return bConnectRequested;
        }
    }

    double ExpiresAt = 0.0;
    Json->TryGetNumberField(TEXT("expiresAt"), ExpiresAt);
    const double NowMs = FDateTime::UtcNow().ToUnixTimestamp() * 1000.0;
    if (ExpiresAt > 0.0 && ExpiresAt < NowMs)
    {
        UE_LOG(LogTemp, Warning, TEXT("HMDao Unreal Capture: expired connect request ignored"));
        ClearConnectRequestFile();
        return bConnectRequested;
    }

    // 读取云端鉴权 token（前端写入意图文件），用于 WS URL 的 owner 分桶。
    HMDaoConnectToken = ReadStringField(Json, TEXT("token"));

    bConnectRequested = true;
    ClearConnectRequestFile();
    UE_LOG(LogTemp, Log, TEXT("HMDao Unreal Capture: consumed on-demand connect request"));
    return true;
}

FString FHMDaoUnrealCaptureModule::GetConnectRequestFilePath() const
{
    return FPaths::Combine(FPlatformProcess::UserTempDir(), HMDaoConnectRequestFileName);
}

void FHMDaoUnrealCaptureModule::ClearConnectRequestFile() const
{
    IFileManager::Get().Delete(*GetConnectRequestFilePath(), false, true, true);
}

void FHMDaoUnrealCaptureModule::Connect()
{
    if (bSocketConnecting || !ShouldAttemptConnect())
    {
        return;
    }

    PrimeWebSocketsForLocalBridge();
    Disconnect();
    // 构造带云端鉴权 token 的连接 URL（后端据此解析 userId 分桶）。
    FString ConnectUrl = HMDaoUnrealWsUrl;
    if (!HMDaoConnectToken.IsEmpty())
    {
        const FString Sep = ConnectUrl.Contains(TEXT("?")) ? TEXT("&") : TEXT("?");
        FString TokenParam = FString(TEXT("token=")) + FGenericPlatformHttp::UrlEncode(HMDaoConnectToken);
        ConnectUrl = ConnectUrl + Sep + TokenParam;
    }
    UE_LOG(LogTemp, Log, TEXT("HMDao Unreal Capture: Connect -> %s"), *ConnectUrl);
    bPreviewStreamingEnabled = false;
    LastPingAt = 0.0;
    LastPongAt = 0.0;
    bSocketConnecting = true;
    Socket = FWebSocketsModule::Get().CreateWebSocket(ConnectUrl);
    Socket->OnConnected().AddLambda([this]() {
        UE_LOG(LogTemp, Log, TEXT("HMDao Unreal Capture: WebSocket connected"));
        bSocketConnecting = false;
        bBridgeSessionSeen = true;
        LastPongAt = FPlatformTime::Seconds();
        ClearConnectRequestFile();
        SendHello();
        SendCameraList();
        SendTimeline();
        FlushPendingRecordingNotice();
    });
    Socket->OnMessage().AddLambda([this](const FString& Message) {
        HandleMessage(Message);
    });
    Socket->OnConnectionError().AddLambda([this](const FString& Error) {
        bSocketConnecting = false;
        LastPongAt = 0.0;
        UE_LOG(LogTemp, Warning, TEXT("HMDao Unreal Capture connection error: %s"), *Error);
        if (bBridgeSessionSeen && !Recording.bActive && !bPreviewStreamingEnabled)
        {
            bBridgeSessionSeen = false;
            bConnectRequested = false;
            StartBootstrapTicker();
            StopRuntimeTicker();
        }
    });
    Socket->OnClosed().AddLambda([this](int32 StatusCode, const FString& Reason, bool bWasClean) {
        bSocketConnecting = false;
        LastPongAt = 0.0;
        UE_LOG(LogTemp, Warning, TEXT("HMDao Unreal Capture closed: %d %s clean=%s"), StatusCode, *Reason, bWasClean ? TEXT("true") : TEXT("false"));
        if (bBridgeSessionSeen && !Recording.bActive && !bPreviewStreamingEnabled)
        {
            bBridgeSessionSeen = false;
            bConnectRequested = false;
            StartBootstrapTicker();
            StopRuntimeTicker();
        }
    });
    Socket->Connect();
}

void FHMDaoUnrealCaptureModule::Disconnect()
{
    bPreviewStreamingEnabled = false;
    bSocketConnecting = false;
    if (Socket.IsValid())
    {
        Socket->Close();
        Socket.Reset();
    }
    LastPongAt = 0.0;
    bBridgeSessionSeen = false;
}

void FHMDaoUnrealCaptureModule::SendHello()
{
    const TSharedRef<FJsonObject> Object = MakeShared<FJsonObject>();
    SetString(Object, TEXT("type"), TEXT("hello"));
    SetString(Object, TEXT("engine"), TEXT("unreal"));
    SetString(Object, TEXT("plugin"), TEXT("HMDao Unreal Capture"));
    SetString(Object, TEXT("pluginVersion"), TEXT("0.3.1"));
    Object->SetNumberField(TEXT("protocolVersion"), 1);
    Object->SetBoolField(TEXT("editor"), true);
    SetString(Object, TEXT("previewProvider"), TEXT("editor-direct"));
    Socket->Send(ToJson(Object));
}

UWorld* FHMDaoUnrealCaptureModule::GetEditorWorld() const
{
    return GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
}

TArray<FHMDaoUnrealCaptureModule::FSceneCameraInfo> FHMDaoUnrealCaptureModule::GatherSceneCameras(UWorld* World) const
{
    TArray<FSceneCameraInfo> Cameras;
    if (!World)
    {
        return Cameras;
    }

    for (TActorIterator<AActor> It(World); It; ++It)
    {
        AActor* Actor = *It;
        if (!IsValid(Actor))
        {
            continue;
        }

        TInlineComponentArray<UCameraComponent*> CameraComponents(Actor);
        if (CameraComponents.Num() == 0)
        {
            continue;
        }

        for (UCameraComponent* CameraComponent : CameraComponents)
        {
            if (!IsValid(CameraComponent))
            {
                continue;
            }

            FSceneCameraInfo Info;
            Info.Actor = Actor;
            Info.CameraComponent = CameraComponent;
            Info.Id = CameraComponent->GetPathName();
            Info.Name = BuildCameraLabel(Actor, CameraComponent);
            Info.Label = Info.Name;
            Cameras.Add(MoveTemp(Info));
        }
    }

    Cameras.Sort([](const FSceneCameraInfo& Left, const FSceneCameraInfo& Right) {
        return Left.Label < Right.Label;
    });

    return Cameras;
}

void FHMDaoUnrealCaptureModule::UpdateSelectedCamera(const FSceneCameraInfo& Camera)
{
    if (!Camera.IsValid())
    {
        SelectedCameraId.Empty();
        SelectedCameraName = TEXT("Editor Viewport");
        return;
    }

    SelectedCameraId = Camera.Id;
    SelectedCameraName = Camera.Label.IsEmpty() ? Camera.Name : Camera.Label;
    if (SelectedCameraName.IsEmpty())
    {
        SelectedCameraName = TEXT("Editor Viewport");
    }
}

FHMDaoUnrealCaptureModule::FSceneCameraInfo FHMDaoUnrealCaptureModule::ResolveViewportCamera() const
{
    FSceneCameraInfo Result;

    FLevelEditorViewportClient* ViewportClient = GCurrentLevelEditingViewportClient ? GCurrentLevelEditingViewportClient : GLastKeyLevelEditingViewportClient;
    if (!ViewportClient)
    {
        return Result;
    }

    UCameraComponent* CameraComponent = ViewportClient->GetCameraComponentForView();
    if (!IsValid(CameraComponent))
    {
        if (AActor* LockedActor = ViewportClient->GetActorLock().GetLockedActor())
        {
            TInlineComponentArray<UCameraComponent*> CameraComponents(LockedActor);
            if (CameraComponents.Num() > 0)
            {
                CameraComponent = CameraComponents[0];
            }
        }
    }

    AActor* Owner = CameraComponent ? CameraComponent->GetOwner() : nullptr;
    if (!IsValid(Owner) || !IsValid(CameraComponent))
    {
        return Result;
    }

    Result.Actor = Owner;
    Result.CameraComponent = CameraComponent;
    Result.Id = CameraComponent->GetPathName();
    Result.Name = BuildCameraLabel(Owner, CameraComponent);
    Result.Label = Result.Name;
    return Result;
}

void FHMDaoUnrealCaptureModule::SyncViewportToSelectedCamera(const FSceneCameraInfo& Camera) const
{
#if WITH_EDITOR
    if (!Camera.IsValid())
    {
        return;
    }

    FLevelEditorViewportClient* ViewportClient = GCurrentLevelEditingViewportClient ? GCurrentLevelEditingViewportClient : GLastKeyLevelEditingViewportClient;
    AActor* CameraActor = Camera.Actor.Get();
    if (!ViewportClient || !IsValid(CameraActor))
    {
        return;
    }

    ViewportClient->SetViewportType(LVT_Perspective);
    ViewportClient->SetCinematicActorLock(CameraActor);
    ViewportClient->SetActorLock(CameraActor);
    ViewportClient->bLockedCameraView = true;
    ViewportClient->UpdateViewForLockedActor();
    if (FViewport* Viewport = ViewportClient->Viewport)
    {
        Viewport->Draw(false);
    }

    UE_LOG(LogTemp, Verbose, TEXT("HMDao Unreal Capture: synced viewport to camera %s"), *Camera.Name);
#endif
}

FHMDaoUnrealCaptureModule::FSceneCameraInfo FHMDaoUnrealCaptureModule::BuildCameraInfoFromComponent(UCameraComponent* CameraComponent) const
{
    FSceneCameraInfo Info;
    if (!IsValid(CameraComponent))
    {
        return Info;
    }

    AActor* Owner = CameraComponent->GetOwner();
    if (!IsValid(Owner))
    {
        return Info;
    }

    Info.Actor = Owner;
    Info.CameraComponent = CameraComponent;
    Info.Id = CameraComponent->GetPathName();
    Info.Name = BuildCameraLabel(Owner, CameraComponent);
    Info.Label = Info.Name;
    return Info;
}

FString FHMDaoUnrealCaptureModule::DescribeCameraInfo(const FSceneCameraInfo& Camera) const
{
    if (!Camera.IsValid())
    {
        return TEXT("<invalid>");
    }

    const UCameraComponent* CameraComponent = Camera.CameraComponent.Get();
    const AActor* Owner = Camera.Actor.Get();
    const FString TransformText = CameraComponent ? DescribeTransform(CameraComponent->GetComponentTransform()) : TEXT("transform=<null>");
    return FString::Printf(
        TEXT("name=%s id=%s actor=%s component=%s %s"),
        *Camera.Name,
        *Camera.Id,
        Owner ? *Owner->GetPathName() : TEXT("<null>"),
        CameraComponent ? *CameraComponent->GetPathName() : TEXT("<null>"),
        *TransformText);
}

FString FHMDaoUnrealCaptureModule::DescribeSequencerState(const TSharedPtr<ISequencer>& Sequencer) const
{
    if (!Sequencer.IsValid())
    {
        return TEXT("sequencer=<null>");
    }

    const UMovieSceneSequence* FocusedSequence = Sequencer->GetFocusedMovieSceneSequence();
    const UMovieScene* MovieScene = FocusedSequence ? FocusedSequence->GetMovieScene() : nullptr;
    const FFrameNumber LocalFrame = Sequencer->GetLocalTime().Time.FloorToFrame();
    return FString::Printf(
        TEXT("sequence=%s movieScene=%s localFrame=%d status=%d"),
        FocusedSequence ? *FocusedSequence->GetPathName() : TEXT("<null>"),
        MovieScene ? *MovieScene->GetPathName() : TEXT("<null>"),
        LocalFrame.Value,
        static_cast<int32>(Sequencer->GetPlaybackStatus()));
}

FHMDaoUnrealCaptureModule::FSceneCameraInfo FHMDaoUnrealCaptureModule::ResolveCameraFromSequencerCut(const TSharedPtr<ISequencer>& Sequencer) const
{
    FSceneCameraInfo Result;
    if (!Sequencer.IsValid())
    {
        return Result;
    }

    UMovieSceneSequence* FocusedSequence = Sequencer->GetFocusedMovieSceneSequence();
    UMovieScene* MovieScene = FocusedSequence ? FocusedSequence->GetMovieScene() : nullptr;
    UMovieSceneCameraCutTrack* CameraCutTrack = MovieScene ? Cast<UMovieSceneCameraCutTrack>(MovieScene->GetCameraCutTrack()) : nullptr;
    if (!CameraCutTrack)
    {
        return Result;
    }

    const FFrameNumber CurrentFrame = Sequencer->GetLocalTime().Time.FloorToFrame();
    const TArray<UMovieSceneSection*>& Sections = CameraCutTrack->GetAllSections();
    for (int32 Index = Sections.Num() - 1; Index >= 0; --Index)
    {
        UMovieSceneCameraCutSection* CutSection = Cast<UMovieSceneCameraCutSection>(Sections[Index]);
        if (!CutSection)
        {
            continue;
        }

        if (!CutSection->GetRange().Contains(CurrentFrame))
        {
            continue;
        }

        const FGuid BindingGuid = CutSection->GetCameraBindingID().GetGuid();
        if (!BindingGuid.IsValid())
        {
            continue;
        }

        const TArrayView<TWeakObjectPtr<>> BoundObjects = Sequencer->FindObjectsInCurrentSequence(BindingGuid);
        for (const TWeakObjectPtr<>& WeakObject : BoundObjects)
        {
            UObject* BoundObject = WeakObject.Get();
            if (UCameraComponent* CameraComponent = Cast<UCameraComponent>(BoundObject))
            {
                return BuildCameraInfoFromComponent(CameraComponent);
            }

            if (AActor* Actor = Cast<AActor>(BoundObject))
            {
                TInlineComponentArray<UCameraComponent*> CameraComponents(Actor);
                for (UCameraComponent* CameraComponent : CameraComponents)
                {
                    if (IsValid(CameraComponent))
                    {
                        return BuildCameraInfoFromComponent(CameraComponent);
                    }
                }
            }
        }
    }

    return Result;
}

FHMDaoUnrealCaptureModule::FSceneCameraInfo FHMDaoUnrealCaptureModule::ResolveCameraFromSequencerBindings(const TSharedPtr<ISequencer>& Sequencer) const
{
    FSceneCameraInfo Result;
    if (!Sequencer.IsValid())
    {
        return Result;
    }

    UMovieSceneSequence* FocusedSequence = Sequencer->GetFocusedMovieSceneSequence();
    UMovieScene* MovieScene = FocusedSequence ? FocusedSequence->GetMovieScene() : nullptr;
    if (!MovieScene)
    {
        return Result;
    }

    // Walk every binding in the focused sequence and return the first camera (or
    // actor owning a camera component) that is bound. A camera driven by a transform
    // track is bound here even though there is no camera-cut track, so this is what
    // lets the capture follow the animated shot.
    const TArray<FMovieSceneBinding>& Bindings = static_cast<const UMovieScene*>(MovieScene)->GetBindings();
    for (const FMovieSceneBinding& Binding : Bindings)
    {
        const TArrayView<TWeakObjectPtr<>> BoundObjects = Sequencer->FindObjectsInCurrentSequence(Binding.GetObjectGuid());
        for (const TWeakObjectPtr<>& WeakObject : BoundObjects)
        {
            UObject* BoundObject = WeakObject.Get();
            if (UCameraComponent* CameraComponent = Cast<UCameraComponent>(BoundObject))
            {
                return BuildCameraInfoFromComponent(CameraComponent);
            }

            if (AActor* Actor = Cast<AActor>(BoundObject))
            {
                TInlineComponentArray<UCameraComponent*> CameraComponents(Actor);
                for (UCameraComponent* CameraComponent : CameraComponents)
                {
                    if (IsValid(CameraComponent))
                    {
                        return BuildCameraInfoFromComponent(CameraComponent);
                    }
                }
            }
        }
    }

    return Result;
}

TSharedPtr<ISequencer> FHMDaoUnrealCaptureModule::FindPreferredEditorSequencer() const
{
    TArray<TWeakPtr<ISequencer>> Sequencers = FLevelEditorSequencerIntegration::Get().GetSequencers();
    TSharedPtr<ISequencer> BestSequencer;
    int32 BestScore = TNumericLimits<int32>::Lowest();

    for (int32 Index = Sequencers.Num() - 1; Index >= 0; --Index)
    {
        TSharedPtr<ISequencer> Sequencer = Sequencers[Index].Pin();
        if (!Sequencer.IsValid())
        {
            continue;
        }

        UMovieSceneSequence* FocusedSequence = Sequencer->GetFocusedMovieSceneSequence();
        UMovieScene* MovieScene = FocusedSequence ? FocusedSequence->GetMovieScene() : nullptr;
        if (!MovieScene)
        {
            continue;
        }

        int32 Score = 0;
        const EMovieScenePlayerStatus::Type Status = Sequencer->GetPlaybackStatus();
        if (Status == EMovieScenePlayerStatus::Playing)
        {
            Score += 1000;
        }
        else if (Status == EMovieScenePlayerStatus::Scrubbing)
        {
            Score += 700;
        }

        FSceneCameraInfo CameraCut = ResolveCameraFromSequencerCut(Sequencer);
        if (!CameraCut.IsValid())
        {
            CameraCut = BuildCameraInfoFromComponent(Sequencer->GetLastEvaluatedCameraCut().Get());
        }
        if (CameraCut.IsValid())
        {
            Score += 400;
            if (!SelectedCameraId.IsEmpty() && CameraCut.Id == SelectedCameraId)
            {
                Score += 500;
            }
            if (!SelectedCameraName.IsEmpty() && (CameraCut.Name == SelectedCameraName || CameraCut.Label == SelectedCameraName || CameraCut.Id == SelectedCameraName))
            {
                Score += 400;
            }
        }

        if (SequenceLikelyTargetsCamera(MovieScene, SelectedCameraId, SelectedCameraName))
        {
            Score += 300;
        }

        FFrameNumber EffectiveLowerTick = 0;
        FFrameNumber EffectiveUpperTickInclusive = 0;
        if (TryGetEffectiveMovieSceneFrameBounds(MovieScene, SelectedCameraId, SelectedCameraName, EffectiveLowerTick, EffectiveUpperTickInclusive))
        {
            Score += FMath::Max(0, EffectiveUpperTickInclusive.Value - EffectiveLowerTick.Value + 1);
        }

        if (Score > BestScore)
        {
            BestSequencer = Sequencer;
            BestScore = Score;
        }
    }

    return BestSequencer;
}

FHMDaoUnrealCaptureModule::FSceneCameraInfo FHMDaoUnrealCaptureModule::ResolveSelectedCamera()
{
    FSceneCameraInfo Empty;
    UWorld* World = GetEditorWorld();
    const TArray<FSceneCameraInfo> Cameras = GatherSceneCameras(World);
    if (Cameras.Num() == 0)
    {
        UpdateSelectedCamera(Empty);
        return Empty;
    }

    const auto MatchesSelection = [this](const FSceneCameraInfo& Camera) {
        if (!SelectedCameraId.IsEmpty() && Camera.Id == SelectedCameraId)
        {
            return true;
        }
        if (!SelectedCameraName.IsEmpty())
        {
            return Camera.Name == SelectedCameraName || Camera.Label == SelectedCameraName || Camera.Id == SelectedCameraName;
        }
        return false;
    };

    for (const FSceneCameraInfo& Camera : Cameras)
    {
        if (MatchesSelection(Camera))
        {
            UpdateSelectedCamera(Camera);
            return Camera;
        }
    }

    if (SelectedCameraId.IsEmpty() && SelectedCameraName.IsEmpty())
    {
        const FSceneCameraInfo ViewportCamera = ResolveViewportCamera();
        if (ViewportCamera.IsValid())
        {
            UpdateSelectedCamera(ViewportCamera);
            return ViewportCamera;
        }
    }

    const FSceneCameraInfo& FirstCamera = Cameras[0];
    UpdateSelectedCamera(FirstCamera);
    return FirstCamera;
}

FHMDaoUnrealCaptureModule::FSceneCameraInfo FHMDaoUnrealCaptureModule::ResolveCaptureCamera()
{
    if (!Recording.bActive)
    {
        if (FSceneCameraInfo SelectedCamera = ResolveSelectedCamera(); SelectedCamera.IsValid())
        {
            return SelectedCamera;
        }
    }

    if (TSharedPtr<ISequencer> Sequencer = Recording.EditorSequencer.Pin())
    {
        if (FSceneCameraInfo ActiveCamera = ResolveCameraFromSequencerCut(Sequencer); ActiveCamera.IsValid())
        {
            return ActiveCamera;
        }

        if (FSceneCameraInfo ActiveCamera = ResolveCameraFromSequencerBindings(Sequencer); ActiveCamera.IsValid())
        {
            return ActiveCamera;
        }

        if (FSceneCameraInfo ActiveCamera = BuildCameraInfoFromComponent(Sequencer->GetLastEvaluatedCameraCut().Get()); ActiveCamera.IsValid())
        {
            return ActiveCamera;
        }
    }

    if (TSharedPtr<ISequencer> Sequencer = FindPreferredEditorSequencer())
    {
        if (FSceneCameraInfo ActiveCamera = ResolveCameraFromSequencerCut(Sequencer); ActiveCamera.IsValid())
        {
            return ActiveCamera;
        }

        if (FSceneCameraInfo ActiveCamera = ResolveCameraFromSequencerBindings(Sequencer); ActiveCamera.IsValid())
        {
            return ActiveCamera;
        }

        if (FSceneCameraInfo ActiveCamera = BuildCameraInfoFromComponent(Sequencer->GetLastEvaluatedCameraCut().Get()); ActiveCamera.IsValid())
        {
            return ActiveCamera;
        }
    }

    return ResolveSelectedCamera();
}

FHMDaoUnrealCaptureModule::FSceneCameraInfo FHMDaoUnrealCaptureModule::ResolveRecordingCamera()
{
    // Prefer the user-selected camera so recording matches the live preview camera
    // (e.g. CineCameraActor_2) instead of silently falling back to the first bound one.
    if (FSceneCameraInfo Camera = ResolveSelectedCamera(); Camera.IsValid())
    {
        return Camera;
    }

    const auto TrySequencer = [this](const TSharedPtr<ISequencer>& Sequencer) -> FSceneCameraInfo
    {
        if (!Sequencer.IsValid())
        {
            return FSceneCameraInfo();
        }

        if (FSceneCameraInfo Camera = ResolveCameraFromSequencerCut(Sequencer); Camera.IsValid())
        {
            return Camera;
        }

        if (FSceneCameraInfo Camera = ResolveCameraFromSequencerBindings(Sequencer); Camera.IsValid())
        {
            return Camera;
        }

        return FSceneCameraInfo();
    };

    if (FSceneCameraInfo Camera = TrySequencer(Recording.EditorSequencer.Pin()); Camera.IsValid())
    {
        return Camera;
    }

    if (FSceneCameraInfo Camera = TrySequencer(FindPreferredEditorSequencer()); Camera.IsValid())
    {
        return Camera;
    }

    const bool bSequenceActive = Recording.EditorSequencer.Pin().IsValid() || FindPreferredEditorSequencer().IsValid();
    if (bSequenceActive)
    {
        // A Level Sequence is open but we could not resolve its camera (e.g. no camera
        // is bound to the sequence). Do NOT fall back to the static editor viewport,
        // which would freeze the recording; surface the failure so the user can select
        // the correct camera / bind one to the sequence.
        return FSceneCameraInfo();
    }

    // No sequence at all: recording the explicitly selected camera (or the editor
    // viewport) is the intended behaviour here.
    if (FSceneCameraInfo Camera = ResolveSelectedCamera(); Camera.IsValid())
    {
        return Camera;
    }

    return FSceneCameraInfo();
}

void FHMDaoUnrealCaptureModule::SendCameraList()
{
    const TSharedRef<FJsonObject> Object = MakeShared<FJsonObject>();
    SetString(Object, TEXT("type"), TEXT("camera_list"));
    TArray<TSharedPtr<FJsonValue>> CamerasJson;

    UWorld* World = GetEditorWorld();
    TArray<FSceneCameraInfo> Cameras = GatherSceneCameras(World);
    const auto AppendUniqueCamera = [&Cameras](const FSceneCameraInfo& CameraInfo)
    {
        if (!CameraInfo.IsValid())
        {
            return;
        }

        const bool bAlreadyPresent = Cameras.ContainsByPredicate([&CameraInfo](const FSceneCameraInfo& Existing) {
            return !Existing.Id.IsEmpty() && Existing.Id == CameraInfo.Id;
        });
        if (!bAlreadyPresent)
        {
            Cameras.Add(CameraInfo);
        }
    };

    if (TSharedPtr<ISequencer> Sequencer = FindPreferredEditorSequencer())
    {
        AppendUniqueCamera(ResolveCameraFromSequencerCut(Sequencer));
        AppendUniqueCamera(BuildCameraInfoFromComponent(Sequencer->GetLastEvaluatedCameraCut().Get()));
    }

    AppendUniqueCamera(ResolveViewportCamera());

    Cameras.Sort([](const FSceneCameraInfo& Left, const FSceneCameraInfo& Right) {
        return Left.Label < Right.Label;
    });

    const FSceneCameraInfo ActiveCamera = ResolveSelectedCamera();
    const FString ActiveCameraId = ActiveCamera.Id;

    for (const FSceneCameraInfo& CameraInfo : Cameras)
    {
        const TSharedRef<FJsonObject> Camera = MakeShared<FJsonObject>();
        SetString(Camera, TEXT("id"), CameraInfo.Id);
        SetString(Camera, TEXT("name"), CameraInfo.Name);
        SetString(Camera, TEXT("label"), CameraInfo.Label);
        Camera->SetBoolField(TEXT("active"), !ActiveCameraId.IsEmpty() && CameraInfo.Id == ActiveCameraId);
        SetString(Camera, TEXT("engine"), TEXT("unreal"));
        CamerasJson.Add(MakeShared<FJsonValueObject>(Camera));
    }

    if (CamerasJson.Num() == 0)
    {
        SelectedCameraId.Empty();
        SelectedCameraName = TEXT("Editor Viewport");
        const TSharedRef<FJsonObject> Camera = MakeShared<FJsonObject>();
        SetString(Camera, TEXT("id"), TEXT("editor-viewport"));
        SetString(Camera, TEXT("name"), SelectedCameraName);
        SetString(Camera, TEXT("label"), SelectedCameraName);
        Camera->SetBoolField(TEXT("active"), true);
        SetString(Camera, TEXT("engine"), TEXT("unreal"));
        CamerasJson.Add(MakeShared<FJsonValueObject>(Camera));
    }

    Object->SetArrayField(TEXT("camera_list"), CamerasJson);
    SetString(Object, TEXT("selected_camera"), SelectedCameraName.IsEmpty() ? TEXT("Editor Viewport") : SelectedCameraName);
    SetString(Object, TEXT("selected_camera_id"), SelectedCameraId.IsEmpty() ? TEXT("editor-viewport") : SelectedCameraId);
    Socket->Send(ToJson(Object));
}

bool FHMDaoUnrealCaptureModule::QueryEditorSequencerTimeline(int32& OutStartFrame, int32& OutEndFrame, int32& OutCurrentFrame, int32& OutFps)
{
    TSharedPtr<ISequencer> Sequencer = Recording.EditorSequencer.Pin();
    if (!Sequencer.IsValid())
    {
        Sequencer = FindPreferredEditorSequencer();
    }
    if (!Sequencer.IsValid())
    {
        return false;
    }

    UMovieSceneSequence* FocusedSequence = Sequencer->GetFocusedMovieSceneSequence();
    UMovieScene* MovieScene = FocusedSequence ? FocusedSequence->GetMovieScene() : nullptr;
    FFrameNumber LowerTick = 0;
    FFrameNumber UpperTickInclusive = 0;
    if (!MovieScene || !TryGetEffectiveMovieSceneFrameBounds(MovieScene, SelectedCameraId, SelectedCameraName, LowerTick, UpperTickInclusive))
    {
        return false;
    }

    const FFrameRate TickResolution = ChooseUsableFrameRate(Sequencer->GetFocusedTickResolution(), MovieScene->GetTickResolution());
    const FFrameRate DisplayRate = ChooseUsableFrameRate(Sequencer->GetFocusedDisplayRate(), MovieScene->GetDisplayRate());
    if (!IsUsableFrameRate(TickResolution) || !IsUsableFrameRate(DisplayRate))
    {
        UE_LOG(LogTemp, Warning, TEXT("HMDao Unreal Capture: skipped sequencer timeline query because frame rate was invalid (tick=%d/%d display=%d/%d)"),
            TickResolution.Numerator, TickResolution.Denominator,
            DisplayRate.Numerator, DisplayRate.Denominator);
        return false;
    }

    const FFrameTime CurrentTick = Sequencer->GetLocalTime().Time;
    FFrameTime StartFrameTime;
    FFrameTime EndFrameTime;
    FFrameTime CurrentFrameTime;
    if (!TryTransformFrameTime(FFrameTime(LowerTick), TickResolution, DisplayRate, StartFrameTime) ||
        !TryTransformFrameTime(FFrameTime(UpperTickInclusive), TickResolution, DisplayRate, EndFrameTime) ||
        !TryTransformFrameTime(CurrentTick, TickResolution, DisplayRate, CurrentFrameTime))
    {
        UE_LOG(LogTemp, Warning, TEXT("HMDao Unreal Capture: skipped sequencer timeline query because time transform could not be evaluated"));
        return false;
    }

    OutStartFrame = StartFrameTime.FloorToFrame().Value;
    OutEndFrame = EndFrameTime.FloorToFrame().Value;
    OutCurrentFrame = CurrentFrameTime.FloorToFrame().Value;
    OutCurrentFrame = FMath::Clamp(OutCurrentFrame, OutStartFrame, OutEndFrame);
    OutFps = FMath::Max(1, FMath::RoundToInt(DisplayRate.AsDecimal()));
    Recording.EditorSequencer = Sequencer;
    return true;
}

bool FHMDaoUnrealCaptureModule::QueryTimeline(int32& OutStartFrame, int32& OutEndFrame, int32& OutCurrentFrame, int32& OutFps)
{
    if (Recording.bActive)
    {
        OutStartFrame = Recording.StartFrame;
        OutEndFrame = Recording.EndFrame;
        OutCurrentFrame = Recording.LastAppliedFrame == TNumericLimits<int32>::Lowest() ? Recording.StartFrame : Recording.LastAppliedFrame;
        OutFps = FMath::Max(1, Recording.Fps);
        return true;
    }

    if (QueryEditorSequencerTimeline(OutStartFrame, OutEndFrame, OutCurrentFrame, OutFps))
    {
        return true;
    }
    return false;
}

void FHMDaoUnrealCaptureModule::SendTimeline()
{
    int32 StartFrame = 1;
    int32 EndFrame = 120;
    int32 CurrentFrame = 1;
    int32 Fps = 30;
    const bool bHasTimeline = QueryTimeline(StartFrame, EndFrame, CurrentFrame, Fps);

    if (!Socket.IsValid() || !Socket->IsConnected())
    {
        return;
    }

    // Always report timeline state (even when no sequence is open) so the frontend can
    // warm the user before recording. has_sequence lets the node prompt "open a Level
    // Sequence first"; has_camera lets it prompt "no camera bound to the sequence".
    const bool bHasSequence = FindPreferredEditorSequencer().IsValid();
    UWorld* World = GetEditorWorld();
    const bool bHasCamera = GatherSceneCameras(World).Num() > 0;

    const TSharedRef<FJsonObject> Object = MakeShared<FJsonObject>();
    SetString(Object, TEXT("type"), TEXT("animation_range"));
    Object->SetNumberField(TEXT("start_frame"), bHasTimeline ? StartFrame : 1);
    Object->SetNumberField(TEXT("end_frame"), bHasTimeline ? EndFrame : 120);
    Object->SetNumberField(TEXT("current_frame"), bHasTimeline ? CurrentFrame : 1);
    Object->SetNumberField(TEXT("fps"), bHasTimeline ? Fps : 30);
    Object->SetBoolField(TEXT("has_sequence"), bHasSequence);
    Object->SetBoolField(TEXT("has_camera"), bHasCamera);
    Socket->Send(ToJson(Object));
}

void FHMDaoUnrealCaptureModule::ApplyPreviewRequest(const TSharedPtr<FJsonObject>& Json)
{
    PreviewWidth = FMath::Clamp(ReadIntField(Json, TEXT("width"), ReadIntField(Json, TEXT("w"), PreviewWidth)), 64, 4096);
    PreviewHeight = FMath::Clamp(ReadIntField(Json, TEXT("height"), ReadIntField(Json, TEXT("h"), PreviewHeight)), 64, 4096);
    PreviewFps = FMath::Clamp(ReadIntField(Json, TEXT("fps"), PreviewFps), 1, 60);
    PreviewQuality = FMath::Clamp(ReadIntField(Json, TEXT("quality"), PreviewQuality), 1, 100);
    PreviewFormat = ReadStringField(Json, TEXT("format"), PreviewFormat);
    bPreviewStreamingEnabled = true;
}

ASceneCapture2D* FHMDaoUnrealCaptureModule::EnsureCaptureActor(UWorld* World)
{
    if (!World)
    {
        return nullptr;
    }

    ASceneCapture2D* CaptureActorInstance = CaptureActor.Get();
    if (CaptureActorInstance && CaptureActorInstance->GetWorld() == World)
    {
        return CaptureActorInstance;
    }

    FActorSpawnParameters SpawnParams;
    SpawnParams.Name = NAME_None;
    SpawnParams.ObjectFlags = RF_Transient;
    SpawnParams.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

    CaptureActorInstance = World->SpawnActor<ASceneCapture2D>(SpawnParams);
    if (!CaptureActorInstance)
    {
        return nullptr;
    }

    CaptureActorInstance->SetActorHiddenInGame(true);
#if WITH_EDITOR
    CaptureActorInstance->SetIsTemporarilyHiddenInEditor(true);
#endif

    if (USceneCaptureComponent2D* CaptureComponent = CaptureActorInstance->GetCaptureComponent2D())
    {
        CaptureComponent->bCaptureEveryFrame = false;
        CaptureComponent->bCaptureOnMovement = false;
        CaptureComponent->bAlwaysPersistRenderingState = true;
        CaptureComponent->CaptureSource = ESceneCaptureSource::SCS_FinalColorLDR;
        CaptureComponent->CompositeMode = SCCM_Overwrite;
        CaptureComponent->ShowFlags.SetPostProcessing(true);
        CaptureComponent->ShowFlags.SetDepthOfField(true);
        CaptureComponent->ShowFlags.SetReflectionEnvironment(true);
        CaptureComponent->ShowFlags.SetScreenSpaceReflections(true);
        CaptureComponent->ShowFlags.SetAmbientOcclusion(true);
        CaptureComponent->ShowFlags.SetTranslucency(true);
        CaptureComponent->ShowFlags.SetLighting(true);
        CaptureComponent->ShowFlags.SetMaterials(true);
        CaptureComponent->ShowFlags.SetGame(true);
        CaptureComponent->ShowFlags.SetEditor(false);
    }

    CaptureActor = CaptureActorInstance;
    return CaptureActorInstance;
}

UTextureRenderTarget2D* FHMDaoUnrealCaptureModule::EnsureRenderTarget(int32 Width, int32 Height)
{
    Width = FMath::Clamp(Width, 64, 4096);
    Height = FMath::Clamp(Height, 64, 4096);

    UTextureRenderTarget2D* Target = RenderTarget.Get();
    if (Target && Target->SizeX == Width && Target->SizeY == Height)
    {
        return Target;
    }

    Target = NewObject<UTextureRenderTarget2D>(GetTransientPackage(), NAME_None, RF_Transient);
    if (!Target)
    {
        return nullptr;
    }

    Target->RenderTargetFormat = RTF_RGBA8;
    Target->bAutoGenerateMips = false;
    Target->ClearColor = FLinearColor::Black;
    Target->InitCustomFormat(Width, Height, PF_B8G8R8A8, false);
    Target->TargetGamma = 2.2f;
    Target->UpdateResourceImmediate(true);
    RenderTarget = TStrongObjectPtr<UTextureRenderTarget2D>(Target);
    return Target;
}

bool FHMDaoUnrealCaptureModule::CaptureFromSelectedCamera(int32 Width, int32 Height, const FString& RequestedFormat, int32 Quality, FString& OutPayload, FString& OutMimeType, int32& OutWidth, int32& OutHeight)
{
    TArray64<uint8> Encoded;
    if (!CaptureFromSelectedCameraBytes(Width, Height, RequestedFormat, Quality, Encoded, OutMimeType, OutWidth, OutHeight))
    {
        return false;
    }

    OutPayload = FBase64::Encode(Encoded.GetData(), Encoded.Num());
    return !OutPayload.IsEmpty();
}

bool FHMDaoUnrealCaptureModule::CaptureFromSelectedCameraBytes(int32 Width, int32 Height, const FString& RequestedFormat, int32 Quality, TArray64<uint8>& OutBytes, FString& OutMimeType, int32& OutWidth, int32& OutHeight)
{
    // During recording we step the Level Sequence deterministically (TickRecording ->
    // SetLocalTimeDirectly + ForceEvaluate). The editor viewport backbuffer does NOT
    // re-render synchronously with ForceEvaluate, so reading it via ReadPixels
    // (CaptureEditorViewportBytes) yields a stale/static image and the recording/preview
    // would be frozen even though the sequence is actually advancing. Render the stepped
    // frame on demand with the SceneCapture2D path instead, which reflects the current
    // world state. We resolve the camera sequence-first (ResolveRecordingCamera) so a
    // camera animated via a transform track (no camera-cut track) is followed too. We
    // deliberately do NOT fall back to the static editor viewport during recording.
    if (Recording.bActive)
    {
        const FSceneCameraInfo RecordingCamera = ResolveRecordingCamera();
        if (RecordingCamera.IsValid())
        {
            return CaptureFromCameraBytes(RecordingCamera, Width, Height, RequestedFormat, Quality, OutBytes, OutMimeType, OutWidth, OutHeight);
        }

        UE_LOG(LogTemp, Warning, TEXT("HMDao Unreal Capture: recording frame could not resolve an animated camera; aborting recording instead of capturing a static viewport frame."));
        return false;
    }

    if (SelectedCameraId.IsEmpty() || SelectedCameraId == TEXT("editor-viewport"))
    {
        UE_LOG(LogTemp, Verbose, TEXT("HMDao Unreal Capture: capturing active editor viewport"));
        return CaptureEditorViewportBytes(Width, Height, Quality, RequestedFormat, OutBytes, OutMimeType, OutWidth, OutHeight);
    }

    if (SelectedCameraName.IsEmpty() || SelectedCameraName == TEXT("Editor Viewport"))
    {
        UE_LOG(LogTemp, Verbose, TEXT("HMDao Unreal Capture: capturing active editor viewport"));
        return CaptureEditorViewportBytes(Width, Height, Quality, RequestedFormat, OutBytes, OutMimeType, OutWidth, OutHeight);
    }

    const FSceneCameraInfo CameraInfo = ResolveCaptureCamera();
    if (!CameraInfo.IsValid())
    {
        return false;
    }

    return CaptureFromCameraBytes(CameraInfo, Width, Height, RequestedFormat, Quality, OutBytes, OutMimeType, OutWidth, OutHeight);
}

bool FHMDaoUnrealCaptureModule::CaptureFromCameraBytes(const FSceneCameraInfo& CameraInfo, int32 Width, int32 Height, const FString& RequestedFormat, int32 Quality, TArray64<uint8>& OutBytes, FString& OutMimeType, int32& OutWidth, int32& OutHeight)
{
    UWorld* World = GetEditorWorld();
    if (!World || !CameraInfo.IsValid())
    {
        return false;
    }

    ASceneCapture2D* CaptureActorInstance = EnsureCaptureActor(World);
    UTextureRenderTarget2D* Target = EnsureRenderTarget(Width, Height);
    if (!CaptureActorInstance || !Target)
    {
        return false;
    }

    USceneCaptureComponent2D* CaptureComponent = CaptureActorInstance->GetCaptureComponent2D();
    UCameraComponent* CameraComponent = CameraInfo.CameraComponent.Get();
    if (!CaptureComponent || !CameraComponent)
    {
        return false;
    }

    const TSharedPtr<ISequencer> ActiveSequencer = Recording.EditorSequencer.Pin().IsValid() ? Recording.EditorSequencer.Pin() : FindPreferredEditorSequencer();
    const FTransform CameraTransform = CameraComponent->GetComponentTransform();
    UE_LOG(LogTemp, Log, TEXT("HMDao Unreal Capture: capture frame camera=%s target=%dx%d format=%s quality=%d sequencer=%s transform=%s"),
        *DescribeCameraInfo(CameraInfo),
        Width,
        Height,
        *RequestedFormat,
        Quality,
        *DescribeSequencerState(ActiveSequencer),
        *DescribeTransform(CameraTransform));
    CaptureActorInstance->SetActorTransform(CameraTransform);
    CaptureComponent->TextureTarget = Target;
    ApplyCameraViewToCapture(CaptureComponent, CameraComponent);
    CaptureComponent->CaptureSource = ESceneCaptureSource::SCS_FinalColorLDR;
    CaptureComponent->Activate();

    TArray<FColor> Pixels;
    bool bDetectedBlackFrame = false;
    const auto TryCaptureScenePixels = [&](bool bCameraCut) -> bool
    {
        CaptureComponent->bCameraCutThisFrame = bCameraCut;
        CaptureComponent->MarkRenderStateDirty();
        CaptureComponent->CaptureScene();
        FlushRenderingCommands();

        FTextureRenderTargetResource* Resource = Target->GameThread_GetRenderTargetResource();
        if (!Resource)
        {
            return false;
        }

        TArray<FColor> CandidatePixels;
        if (!Resource->ReadPixels(CandidatePixels) || CandidatePixels.Num() == 0)
        {
            return false;
        }

        if (LooksLikeNearBlackFrame(CandidatePixels))
        {
            bDetectedBlackFrame = true;
            return false;
        }

        Pixels = MoveTemp(CandidatePixels);
        return true;
    };

    if (!TryCaptureScenePixels(true) && !TryCaptureScenePixels(false))
    {
        if (bDetectedBlackFrame)
        {
            UE_LOG(LogTemp, Warning, TEXT("HMDao Unreal Capture: scene capture returned a near-black frame for %s; falling back to editor viewport capture"), *DescribeCameraInfo(CameraInfo));
        }
        else
        {
            UE_LOG(LogTemp, Warning, TEXT("HMDao Unreal Capture: scene capture failed for %s; falling back to editor viewport capture"), *DescribeCameraInfo(CameraInfo));
        }

        SyncViewportToSelectedCamera(CameraInfo);
        return CaptureEditorViewportBytes(Width, Height, Quality, RequestedFormat, OutBytes, OutMimeType, OutWidth, OutHeight);
    }

    OutWidth = Target->SizeX;
    OutHeight = Target->SizeY;
    return EncodePixels(Pixels, OutWidth, OutHeight, RequestedFormat, Quality, OutBytes, OutMimeType);
}

bool FHMDaoUnrealCaptureModule::CaptureEditorViewport(int32 RequestedWidth, int32 RequestedHeight, int32 Quality, const FString& RequestedFormat, FString& OutPayload, FString& OutMimeType, int32& OutWidth, int32& OutHeight) const
{
    TArray64<uint8> Encoded;
    if (!CaptureEditorViewportBytes(RequestedWidth, RequestedHeight, Quality, RequestedFormat, Encoded, OutMimeType, OutWidth, OutHeight))
    {
        return false;
    }

    OutPayload = FBase64::Encode(Encoded.GetData(), Encoded.Num());
    return !OutPayload.IsEmpty();
}

bool FHMDaoUnrealCaptureModule::CaptureEditorViewportBytes(int32 RequestedWidth, int32 RequestedHeight, int32 Quality, const FString& RequestedFormat, TArray64<uint8>& OutBytes, FString& OutMimeType, int32& OutWidth, int32& OutHeight) const
{
    OutWidth = 0;
    OutHeight = 0;
    if (!GEditor || !GEditor->GetActiveViewport())
    {
        return false;
    }

    FViewport* Viewport = GEditor->GetActiveViewport();
    const int32 SourceWidth = Viewport->GetSizeXY().X;
    const int32 SourceHeight = Viewport->GetSizeXY().Y;
    if (SourceWidth <= 0 || SourceHeight <= 0)
    {
        return false;
    }

    TArray<FColor> Pixels;
    if (!Viewport->ReadPixels(Pixels) || Pixels.Num() == 0)
    {
        return false;
    }

    const int32 TargetWidth = RequestedWidth > 0 ? RequestedWidth : SourceWidth;
    const int32 TargetHeight = RequestedHeight > 0 ? RequestedHeight : SourceHeight;
    if (TargetWidth != SourceWidth || TargetHeight != SourceHeight)
    {
        TArray<FColor> ResizedPixels;
        FImageUtils::ImageResize(SourceWidth, SourceHeight, Pixels, TargetWidth, TargetHeight, ResizedPixels, false);
        if (ResizedPixels.Num() <= 0)
        {
            return false;
        }

        OutWidth = TargetWidth;
        OutHeight = TargetHeight;
        return EncodePixels(ResizedPixels, OutWidth, OutHeight, RequestedFormat, Quality, OutBytes, OutMimeType);
    }

    OutWidth = SourceWidth;
    OutHeight = SourceHeight;
    return EncodePixels(Pixels, OutWidth, OutHeight, RequestedFormat, Quality, OutBytes, OutMimeType);
}

void FHMDaoUnrealCaptureModule::SendFrame()
{
    if (!Socket.IsValid() || !Socket->IsConnected())
    {
        return;
    }

    const bool bUseEditorViewport =
        SelectedCameraId.IsEmpty() ||
        SelectedCameraId == TEXT("editor-viewport") ||
        SelectedCameraName.IsEmpty() ||
        SelectedCameraName == TEXT("Editor Viewport");
    const FSceneCameraInfo CameraInfo = ResolveCaptureCamera();
    if (!bUseEditorViewport && !CameraInfo.IsValid())
    {
        UE_LOG(LogTemp, Verbose, TEXT("HMDao Unreal Capture: no valid camera for preview frame"));
        return;
    }

    FString Payload;
    FString MimeType;
    int32 Width = 0;
    int32 Height = 0;

    const bool bCaptured = CaptureFromSelectedCamera(PreviewWidth, PreviewHeight, PreviewFormat, PreviewQuality, Payload, MimeType, Width, Height);
    if (!bCaptured)
    {
        const FString PreviewCameraName = bUseEditorViewport ? TEXT("Editor Viewport") : CameraInfo.Name;
        UE_LOG(LogTemp, Warning, TEXT("HMDao Unreal Capture: preview capture failed for %s"), *PreviewCameraName);
        return;
    }

    const FString PreviewCameraName = bUseEditorViewport ? TEXT("Editor Viewport") : CameraInfo.Name;
    const FString PreviewCameraId = bUseEditorViewport ? TEXT("editor-viewport") : CameraInfo.Id;
    const TSharedRef<FJsonObject> Object = MakeShared<FJsonObject>();
    SetString(Object, TEXT("type"), TEXT("preview_frame"));
    Object->SetNumberField(TEXT("width"), Width);
    Object->SetNumberField(TEXT("height"), Height);
    SetString(Object, TEXT("cameraName"), PreviewCameraName);
    SetString(Object, TEXT("cameraId"), PreviewCameraId);
    SetString(Object, TEXT("mimeType"), MimeType);
    SetString(Object, TEXT("payload"), Payload);
    Object->SetNumberField(TEXT("latencyMs"), 0);
    Socket->Send(ToJson(Object));
}
void FHMDaoUnrealCaptureModule::BeginRecording(const TSharedPtr<FJsonObject>& Json)
{
    StopRecording(false);

    int32 TimelineStartFrame = 1;
    int32 TimelineEndFrame = 1;
    int32 TimelineCurrentFrame = 1;
    int32 TimelineFps = 24;
    const bool bHasActiveTimeline = QueryEditorSequencerTimeline(TimelineStartFrame, TimelineEndFrame, TimelineCurrentFrame, TimelineFps);
    if (!bHasActiveTimeline)
    {
        TimelineStartFrame = ReadIntField(Json, TEXT("startFrame"), ReadIntField(Json, TEXT("start_frame"), 1));
        TimelineEndFrame = ReadIntField(Json, TEXT("endFrame"), ReadIntField(Json, TEXT("end_frame"), 120));
        if (TimelineEndFrame < TimelineStartFrame)
        {
            Swap(TimelineStartFrame, TimelineEndFrame);
        }
        TimelineCurrentFrame = TimelineStartFrame;
        TimelineFps = FMath::Clamp(ReadIntField(Json, TEXT("fps"), 24), 1, HMDaoMaxRecordingFps);
        UE_LOG(LogTemp, Log, TEXT("HMDao Unreal Capture: no active Sequence found; recording selected camera directly start=%d end=%d fps=%d"),
            TimelineStartFrame,
            TimelineEndFrame,
            TimelineFps);
    }

    Recording.bActive = true;
    Recording.StartedAt = FPlatformTime::Seconds();
    Recording.RequestId = ReadStringField(Json, TEXT("requestId"));
    Recording.OutputFormat = NormalizeRecordingOutputFormat(ReadStringField(Json, TEXT("format"), TEXT("webm")));
    const bool bHasExplicitStartFrame = HasNumberField(Json, TEXT("startFrame")) || HasNumberField(Json, TEXT("start_frame"));
    const bool bHasExplicitEndFrame = HasNumberField(Json, TEXT("endFrame")) || HasNumberField(Json, TEXT("end_frame"));
    Recording.StartFrame = ReadIntField(Json, TEXT("startFrame"), ReadIntField(Json, TEXT("start_frame"), TimelineStartFrame));
    Recording.EndFrame = ReadIntField(Json, TEXT("endFrame"), ReadIntField(Json, TEXT("end_frame"), TimelineEndFrame));
    if (Recording.EndFrame < Recording.StartFrame)
    {
        Swap(Recording.StartFrame, Recording.EndFrame);
    }
    if (!bHasExplicitStartFrame)
    {
        Recording.StartFrame = FMath::Clamp(Recording.StartFrame, TimelineStartFrame, TimelineEndFrame);
    }
    if (!bHasExplicitEndFrame)
    {
        Recording.EndFrame = FMath::Clamp(Recording.EndFrame, Recording.StartFrame, TimelineEndFrame);
    }
    Recording.Fps = FMath::Clamp(ReadIntField(Json, TEXT("fps"), TimelineFps), 1, HMDaoMaxRecordingFps);
    Recording.LastAppliedFrame = TNumericLimits<int32>::Lowest();
    Recording.CapturedFrameCount = 0;
    Recording.bPlaybackStarted = false;
    Recording.CapturedWidth = 0;
    Recording.CapturedHeight = 0;
    Recording.FrameFormat = TEXT("png");
    PreviewWidth = FMath::Clamp(ReadIntField(Json, TEXT("width"), ReadIntField(Json, TEXT("w"), PreviewWidth)), 64, 4096);
    PreviewHeight = FMath::Clamp(ReadIntField(Json, TEXT("height"), ReadIntField(Json, TEXT("h"), PreviewHeight)), 64, 4096);
    PreviewFps = Recording.Fps;

    // Recording is rendered at the requested resolution (default 1920x1080), fully
    // decoupled from the preview stream resolution. This is what fixes the "blurry /
    // not 1080p" output: previously SaveRecordingFrame captured at PreviewWidth/Height.
    Recording.CaptureWidth = FMath::Clamp(ReadIntField(Json, TEXT("captureWidth"), ReadIntField(Json, TEXT("recordWidth"), 1920)), 64, 4096);
    Recording.CaptureHeight = FMath::Clamp(ReadIntField(Json, TEXT("captureHeight"), ReadIntField(Json, TEXT("recordHeight"), 1080)), 64, 4096);

    const FString RequestToken = Recording.RequestId.IsEmpty()
        ? FDateTime::UtcNow().ToString(TEXT("%Y%m%d-%H%M%S"))
        : Recording.RequestId;
    const FString SessionName = FPaths::MakeValidFileName(FString::Printf(TEXT("capture-%s"), *RequestToken));
    Recording.SessionDirectory = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("HMDaoUnrealCapture"), TEXT("Recordings"), SessionName);
    Recording.OutputFilePath = FPaths::Combine(
        Recording.SessionDirectory,
        FString::Printf(TEXT("recording.%s"), *Recording.OutputFormat));
    IFileManager::Get().MakeDirectory(*Recording.SessionDirectory, true);
    IFileManager::Get().Delete(*Recording.OutputFilePath, false, true, true);

    // --- Editor-sequencer-driven recording (no duplicate objects) ----------------------------
    // We drive the SAME editor Level Sequence the user sees when they press Play in the
    // Sequencer. Pressing Play in the Sequencer correctly evaluates skeletal animation,
    // Niagara particles and physics, so stepping that same sequencer frame-by-frame captures
    // exactly what the live viewport shows (WYSIWYG). We deliberately do NOT create a separate
    // ULevelSequencePlayer: that would spawn its own duplicate actors/objects into the level
    // (the "extra skeleton instance" reported) and a standalone player does not drive the
    // editor's live spawnables / Niagara systems the same way. Driving the editor sequencer in
    // place creates ZERO extra objects - we only move the playhead and capture the camera view.

    // Remember every open sequencer and its current time so we can restore them after recording.
    TArray<TWeakPtr<ISequencer>> OpenSequencers = FLevelEditorSequencerIntegration::Get().GetSequencers();
    for (const TWeakPtr<ISequencer>& WeakSeq : OpenSequencers)
    {
        TSharedPtr<ISequencer> Seq = WeakSeq.Pin();
        if (Seq.IsValid())
        {
            Recording.OpenSequencersDuringRecord.Add(WeakSeq);
            Recording.OpenSequencerSavedTimes.Add(Seq->GetLocalTime());
        }
    }

    // Choose the recorded (primary) sequence: the explicitly-selected/preferred one.
    TSharedPtr<ISequencer> PrimarySequencer = Recording.EditorSequencer.Pin();
    if (!PrimarySequencer.IsValid())
    {
        PrimarySequencer = FindPreferredEditorSequencer();
        Recording.EditorSequencer = PrimarySequencer;
    }
    Recording.RecordingSequencer = PrimarySequencer;

    // Cache tick/display rates + tick-space bounds from the primary sequence (used for the
    // frame-step mapping below).
    if (TSharedPtr<ISequencer> Seq = PrimarySequencer)
    {
        const UMovieSceneSequence* FocusedSequence = Seq->GetFocusedMovieSceneSequence();
        const UMovieScene* MovieScene = FocusedSequence ? FocusedSequence->GetMovieScene() : nullptr;
        Recording.TickResolution = ChooseUsableFrameRate(
            Seq->GetFocusedTickResolution(),
            MovieScene ? MovieScene->GetTickResolution() : FFrameRate(),
            FFrameRate(24000, 1));
        Recording.DisplayRate = ChooseUsableFrameRate(
            Seq->GetFocusedDisplayRate(),
            MovieScene ? MovieScene->GetDisplayRate() : FFrameRate(),
            FFrameRate(FMath::Max(1, Recording.Fps), 1));
        Recording.bHasFrameRates = true;

        FFrameNumber LowerTick = 0;
        FFrameNumber UpperTickInclusive = 0;
        if (MovieScene && TryGetEffectiveMovieSceneFrameBounds(const_cast<UMovieScene*>(MovieScene), SelectedCameraId, SelectedCameraName, LowerTick, UpperTickInclusive))
        {
            Recording.SequenceStartTick = FMath::Min(LowerTick.Value, UpperTickInclusive.Value);
            Recording.SequenceEndTick = FMath::Max(LowerTick.Value, UpperTickInclusive.Value);
            Recording.bHasSequenceTicks = true;
        }
        else
        {
            Recording.bHasSequenceTicks = false;
        }

        Recording.SavedEditorTime = Seq->GetLocalTime();
        Recording.bHasSavedEditorTime = true;
    }

    const TSharedRef<FJsonObject> Object = MakeShared<FJsonObject>();
    SetString(Object, TEXT("type"), TEXT("recording_started"));
    SetString(Object, TEXT("camera_name"), SelectedCameraName.IsEmpty() ? TEXT("Editor Viewport") : SelectedCameraName);
    SetString(Object, TEXT("camera_id"), SelectedCameraId);
    Object->SetNumberField(TEXT("start_frame"), Recording.StartFrame);
    Object->SetNumberField(TEXT("end_frame"), Recording.EndFrame);
    Object->SetNumberField(TEXT("fps"), Recording.Fps);
    Socket->Send(ToJson(Object));

    SendTimeline();

    // IMPORTANT: Do NOT call TickRecording() inline here. This method runs on the
    // WebSocket callback thread, and TickRecording() performs sequence evaluation, actor
    // spawning (ULevelSequencePlayer) and CaptureScene() which MUST execute on the game
    // thread. Instead we ensure the runtime ticker is active (it runs on the game thread
    // at ~60Hz) and let IT capture the first frame on its very next tick. This keeps all
    // evaluation/capture work off the WS callback thread. Recording.bActive is already true,
    // so the ticker will not early-return and will pick up the first frame (and lazily create
    // the recording players) on the next game-thread tick. StartRuntimeTicker() is idempotent,
    // so calling it here is safe even if the ticker is already running.
    StartRuntimeTicker();
}

void FHMDaoUnrealCaptureModule::FlushPendingRecordingNotice()
{
    if (!PendingRecordingNotice.bValid || !Socket.IsValid() || !Socket->IsConnected())
    {
        return;
    }

    const TSharedRef<FJsonObject> Object = MakeShared<FJsonObject>();
    SetString(Object, TEXT("type"), TEXT("recording_done"));
    if (!PendingRecordingNotice.RequestId.IsEmpty())
    {
        SetString(Object, TEXT("requestId"), PendingRecordingNotice.RequestId);
    }
    SetString(Object, TEXT("cameraName"), PendingRecordingNotice.CameraName.IsEmpty() ? TEXT("Editor Viewport") : PendingRecordingNotice.CameraName);
    SetString(Object, TEXT("cameraId"), PendingRecordingNotice.CameraId);
    Object->SetNumberField(TEXT("startFrame"), PendingRecordingNotice.StartFrame);
    Object->SetNumberField(TEXT("endFrame"), PendingRecordingNotice.EndFrame);
    Object->SetNumberField(TEXT("fps"), PendingRecordingNotice.Fps);

    const TSharedRef<FJsonObject> Asset = MakeShared<FJsonObject>();
    SetString(Asset, TEXT("kind"), TEXT("video"));
    SetString(Asset, TEXT("mimeType"), PendingRecordingNotice.OutputMimeType);
    Asset->SetNumberField(TEXT("width"), PendingRecordingNotice.Width);
    Asset->SetNumberField(TEXT("height"), PendingRecordingNotice.Height);
    Asset->SetNumberField(TEXT("durationMs"), PendingRecordingNotice.DurationMs);
    Asset->SetNumberField(TEXT("sizeBytes"), static_cast<double>(FMath::Max<int64>(0, PendingRecordingNotice.SizeBytes)));
    SetString(Asset, TEXT("cameraName"), PendingRecordingNotice.CameraName.IsEmpty() ? TEXT("Editor Viewport") : PendingRecordingNotice.CameraName);
    SetString(Asset, TEXT("cameraId"), PendingRecordingNotice.CameraId);
    SetString(Asset, TEXT("filePath"), PendingRecordingNotice.OutputFilePath);
    Object->SetObjectField(TEXT("asset"), Asset);
    Socket->Send(ToJson(Object));
    PendingRecordingNotice = FPendingRecordingNotice();
}

void FHMDaoUnrealCaptureModule::SendRecordingDone(int32 Width, int32 Height, int32 DurationMs)
{
    FString OutputFilePath;
    FString OutputMimeType;
    int64 OutputSizeBytes = 0;
    if (!FinalizeRecordingOutput(DurationMs, OutputFilePath, OutputMimeType, OutputSizeBytes))
    {
        if (Socket.IsValid() && Socket->IsConnected())
        {
            const TSharedRef<FJsonObject> ErrorObject = MakeShared<FJsonObject>();
            SetString(ErrorObject, TEXT("type"), TEXT("error"));
            SetString(ErrorObject, TEXT("message"), TEXT("HMDao Unreal Capture failed to assemble a real recording file. Check ffmpeg availability and capture logs."));
            Socket->Send(ToJson(ErrorObject));
        }
        else
        {
            UE_LOG(LogTemp, Warning, TEXT("HMDao Unreal Capture: recording finished locally but output assembly failed while bridge socket was offline"));
        }
        return;
    }

    PendingRecordingNotice = FPendingRecordingNotice();
    PendingRecordingNotice.bValid = true;
    PendingRecordingNotice.RequestId = Recording.RequestId;
    PendingRecordingNotice.CameraName = SelectedCameraName;
    PendingRecordingNotice.CameraId = SelectedCameraId;
    PendingRecordingNotice.OutputFormat = Recording.OutputFormat;
    PendingRecordingNotice.OutputFilePath = OutputFilePath;
    PendingRecordingNotice.OutputMimeType = OutputMimeType;
    PendingRecordingNotice.StartFrame = Recording.StartFrame;
    PendingRecordingNotice.EndFrame = Recording.EndFrame;
    PendingRecordingNotice.Fps = Recording.Fps;
    PendingRecordingNotice.Width = Width;
    PendingRecordingNotice.Height = Height;
    PendingRecordingNotice.DurationMs = DurationMs;
    PendingRecordingNotice.SizeBytes = OutputSizeBytes;
    FlushPendingRecordingNotice();
}

void FHMDaoUnrealCaptureModule::StopRecording(bool bNotifyStopped)
{
    if (!Recording.bActive && !Recording.EditorSequencer.IsValid())
    {
        return;
    }

    // Restore every open editor sequencer to its pre-recording time and re-evaluate. We never
    // spawned/destroyed any actors during recording (we only stepped the editor sequencer's
    // playhead), so this simply returns each sequence to exactly where the user left it.
    for (int32 i = 0; i < Recording.OpenSequencersDuringRecord.Num(); ++i)
    {
        TSharedPtr<ISequencer> Seq = Recording.OpenSequencersDuringRecord[i].Pin();
        if (Seq.IsValid() && Recording.OpenSequencerSavedTimes.IsValidIndex(i))
        {
            Seq->SetPlaybackStatus(EMovieScenePlayerStatus::Stopped);
            Seq->SetLocalTimeDirectly(Recording.OpenSequencerSavedTimes[i].Time, true);
            Seq->ForceEvaluate();
        }
    }

    // Safety net: never leave any skeletal mesh in a forced tick-in-editor state after a
    // recording (recording itself no longer enables it, but restore in case it was toggled).
    EnableSkeletalTickInEditor(false);

    Recording = FRecordingState();
    SendTimeline();

    if (bNotifyStopped && Socket.IsValid() && Socket->IsConnected())
    {
        const TSharedRef<FJsonObject> Object = MakeShared<FJsonObject>();
        SetString(Object, TEXT("type"), TEXT("recording_stopped"));
        SetString(Object, TEXT("camera_name"), SelectedCameraName.IsEmpty() ? TEXT("Editor Viewport") : SelectedCameraName);
        SetString(Object, TEXT("camera_id"), SelectedCameraId);
        Socket->Send(ToJson(Object));
    }
}

void FHMDaoUnrealCaptureModule::EnableSkeletalTickInEditor(bool bEnable)
{
    UWorld* World = GetEditorWorld();
    if (!World)
    {
        return;
    }
    int32 Toggled = 0;
    for (TActorIterator<AActor> It(World); It; ++It)
    {
        for (UActorComponent* Component : It->GetComponents())
        {
            if (USkeletalMeshComponent* Skel = Cast<USkeletalMeshComponent>(Component))
            {
                Skel->bTickInEditor = bEnable;
                Skel->MarkRenderStateDirty();
                ++Toggled;
            }
        }
    }
    UE_LOG(LogTemp, Log, TEXT("HMDao Unreal Capture: EnableSkeletalTickInEditor(%s) toggled %d skeletal components"),
        bEnable ? TEXT("true") : TEXT("false"), Toggled);
}

void FHMDaoUnrealCaptureModule::StepRecordingFrame(int32 DisplayFrame)
{
    // 1) Pose everything the SEQUENCE controls: skeletal animation tracks (AnimSequence
    //    referenced on a bound SkeletalMesh), camera transforms, etc. This is what makes the
    //    captured skeleton actually move. We must NOT enable bTickInEditor on the skeletal
    //    meshes: with bTickInEditor=true, USkeletalMeshComponent::TickComponent re-runs and
    //    resets the pose to the bind pose, clobbering the sequence-written animation and
    //    freezing the skeleton in the capture.
    if (TSharedPtr<ISequencer> Seq = Recording.RecordingSequencer.Pin())
    {
        Seq->SetPlaybackStatus(EMovieScenePlayerStatus::Stopped);
        const FFrameTime TickTime = Recording.bHasFrameRates
            ? ConvertFrameTime(FFrameTime(FFrameNumber(DisplayFrame)), Recording.DisplayRate, Recording.TickResolution)
            : FFrameTime(FFrameNumber(DisplayFrame));
        Seq->SetLocalTimeDirectly(TickTime, true);
        Seq->ForceEvaluate();
    }

    // 2) Advance WORLD-DRIVEN simulation by exactly one recorded frame so hair / Groom
    //    physics, Niagara particle systems, physics and non-sequence spawnables all advance
    //    in lockstep with the captured clip (no static hair/particles, no fast-forward). The
    //    skeletal meshes keep the sequence-posed pose because bTickInEditor is false, so this
    //    tick does NOT reset them. Order matters: pose the skeleton (step 1) first, then
    //    simulate hair from that already-posed skeleton.
    if (UWorld* World = GetEditorWorld())
    {
        if (!World->bInTick)
        {
            World->Tick(LEVELTICK_All, 1.0f / static_cast<float>(FMath::Max(1, Recording.Fps)));
        }
    }

    // The camera viewport is captured by SaveRecordingFrame (below), which renders the SAME
    // final-color image the editor viewport shows (post-processing, reflections, SSR, Lumen,
    // translucency, particles, hair, fluid - everything). So the clip is automatically
    // frame-synced and WYSIWYG with what the camera sees during playback. No per-component
    // simulation probing is needed; the captured frame already contains it all.
}

void FHMDaoUnrealCaptureModule::TickRecording(double Now)
{
    if (!Recording.bActive)
    {
        return;
    }

    const int32 TotalRange = FMath::Max(1, Recording.EndFrame - Recording.StartFrame + 1);
    // Set when real-time playback capture reaches the end frame or the sequencer stops on its own.
    bool bPlaybackFinished = false;

    if (Recording.CapturedFrameCount == 0)
    {
        UE_LOG(LogTemp, Log, TEXT("HMDao Unreal Capture: RECORD HEADER Fps=%d range=%d-%d total=%d mode=editor-sequencer-step tickRes=%d/%d displayRate=%d/%d"),
            Recording.Fps,
            Recording.StartFrame,
            Recording.EndFrame,
            TotalRange,
            Recording.TickResolution.Numerator, Recording.TickResolution.Denominator,
            Recording.DisplayRate.Numerator, Recording.DisplayRate.Denominator);
    }

    // When a live editor sequence is present we PLAY it (real-time) so world-driven simulation
    // advances in lockstep with the sequence-bound tracks (WYSIWYG). The capture loop below
    // grabs one frame per advanced display frame. We do NOT create a separate player, so no
    // extra objects are spawned into the level.
    if (Recording.CapturedFrameCount < TotalRange)
    {
        // --- Deterministic per-frame stepping (frame-accurate, WYSIWYG) ----------------
        // We deliberately do NOT capture during real-time SetPlaybackStatus(Playing): a
        // synchronous SceneCapture2D + PNG encode + disk write at 1080p costs ~0.3s per
        // frame, so during real-time playback we only grab ~1 in 10 frames while the
        // sequence advances 10 display frames between grabs. Played back at Recording.Fps
        // that is a ~10x fast-forward with frames missing. Stepping one display frame at a
        // time and capturing each step yields exactly TotalRange frames at the correct
        // cadence, so the output is real-time length and nothing is dropped.
        //
        // IMPORTANT (skeletal animation on Sequencer Animation Tracks):
        // The user drives skeletal animation by binding a SkeletalMesh to the Level Sequence
        // and adding an Animation Track that references an AnimSequence. This is EVALUATED BY
        // THE SEQUENCER via ForceEvaluate() - it does NOT need, and must NOT have, the skeletal
        // mesh ticking in the editor (bTickInEditor) nor a world Tick(). Enabling bTickInEditor
        // makes USkeletalMeshComponent::TickComponent run every frame and RESET the pose to the
        // (non-AnimBP) default bind pose, clobbering the sequence-written AnimSequence pose and
        // freezing the skeleton in the capture. A world Tick() can also disturb Transform / physics
        // tracks. So we ONLY step + ForceEvaluate the sequencer and capture; nothing else touches
        // the skeleton. This is exactly what makes the recorded clip show the animation.
        if (!Recording.bPlaybackStarted)
        {
            Recording.bPlaybackStarted = true;
            Recording.LastAppliedFrame = TNumericLimits<int32>::Lowest();
            UE_LOG(LogTemp, Log, TEXT("HMDao Unreal Capture: RECORD STEP START range=%d-%d fps=%d (deterministic per-frame capture, sequencer-anim-track only)"),
                Recording.StartFrame, Recording.EndFrame, Recording.Fps);
        }

        const int32 DisplayFrame = Recording.StartFrame + Recording.CapturedFrameCount;

        // Step the sequence (pose skeletal animation tracks / camera) and advance world-driven
        // simulation (hair / Groom physics, Niagara particles) by exactly one recorded frame.
        // Shared with the diagnostics automation test so the test exercises the EXACT code path
        // used during a real recording.
        StepRecordingFrame(DisplayFrame);

        if (!SaveRecordingFrame(DisplayFrame))
        {
            if (Socket.IsValid() && Socket->IsConnected())
            {
                const TSharedRef<FJsonObject> ErrorObject = MakeShared<FJsonObject>();
                SetString(ErrorObject, TEXT("type"), TEXT("error"));
                SetString(ErrorObject, TEXT("message"), TEXT("HMDao Unreal Capture failed to save a recording frame."));
                Socket->Send(ToJson(ErrorObject));
            }
            StopRecording(false);
            return;
        }
        Recording.CapturedFrameCount += 1;
        Recording.LastAppliedFrame = DisplayFrame;
        UE_LOG(LogTemp, Verbose, TEXT("HMDao Unreal Capture: step capture sampleIndex=%d displayFrame=%d"),
            Recording.CapturedFrameCount, DisplayFrame);
    }

    if (Recording.CapturedFrameCount >= TotalRange || bPlaybackFinished)
    {
        const int32 CapturedFrames = FMath::Max(1, Recording.CapturedFrameCount);
        const int32 DurationMs = FMath::Max(1, FMath::RoundToInt((static_cast<double>(CapturedFrames) / static_cast<double>(FMath::Max(1, Recording.Fps))) * 1000.0));
        SendRecordingDone(
            Recording.CapturedWidth > 0 ? Recording.CapturedWidth : PreviewWidth,
            Recording.CapturedHeight > 0 ? Recording.CapturedHeight : PreviewHeight,
            DurationMs);
        StopRecording(false);
        return;
    }
}

bool FHMDaoUnrealCaptureModule::SaveRecordingFrame(int32 FrameNumber)
{
    if (Recording.SessionDirectory.IsEmpty())
    {
        return false;
    }

    TArray64<uint8> Encoded;
    FString MimeType;
    int32 Width = 0;
    int32 Height = 0;
    if (!CaptureFromSelectedCameraBytes(Recording.CaptureWidth, Recording.CaptureHeight, Recording.FrameFormat, 100, Encoded, MimeType, Width, Height))
    {
        UE_LOG(LogTemp, Warning, TEXT("HMDao Unreal Capture: failed to capture recording frame %d at %dx%d"), FrameNumber, Recording.CaptureWidth, Recording.CaptureHeight);
        return false;
    }

    const FString FramePath = FPaths::Combine(
        Recording.SessionDirectory,
        FString::Printf(TEXT("frame-%06d.%s"), Recording.CapturedFrameCount, *Recording.FrameFormat));
    if (!SaveBytesToFile(Encoded, FramePath))
    {
        UE_LOG(LogTemp, Warning, TEXT("HMDao Unreal Capture: failed to save recording frame %d to %s"), FrameNumber, *FramePath);
        return false;
    }

    Recording.CapturedWidth = Width;
    Recording.CapturedHeight = Height;
    return true;
}

bool FHMDaoUnrealCaptureModule::FinalizeRecordingOutput(int32 DurationMs, FString& OutFilePath, FString& OutMimeType, int64& OutSizeBytes)
{
    OutFilePath = Recording.OutputFilePath;
    OutMimeType = ResolveRecordingMimeType(Recording.OutputFormat);
    OutSizeBytes = 0;

    if (Recording.CapturedFrameCount <= 0 || Recording.SessionDirectory.IsEmpty())
    {
        return false;
    }

    const FString FramePattern = FPaths::Combine(
        Recording.SessionDirectory,
        FString::Printf(TEXT("frame-%%06d.%s"), *Recording.FrameFormat));
    FString OutputFormat = NormalizeRecordingOutputFormat(Recording.OutputFormat);
    FString StdOut;
    FString StdErr;
    int32 ReturnCode = -1;

    auto TryEncode = [&](const FString& CandidateFormat, const FString& CandidateOutputPath, const FString& VideoArgs) -> bool
    {
        FString CandidateStdOut;
        FString CandidateStdErr;
        int32 CandidateReturnCode = -1;
        const FString EncodeArgs = FString::Printf(
            TEXT("-hide_banner -loglevel error -y -framerate %d -start_number 0 -i %s %s%s"),
            FMath::Max(1, Recording.Fps),
            *QuoteProcessArgument(FramePattern),
            *VideoArgs,
            *QuoteProcessArgument(CandidateOutputPath));
        const bool bProcessOk = FPlatformProcess::ExecProcess(TEXT("ffmpeg"), *EncodeArgs, &CandidateReturnCode, &CandidateStdOut, &CandidateStdErr);
        const bool bOutputExists = FPaths::FileExists(CandidateOutputPath);
        if (bProcessOk && CandidateReturnCode == 0 && bOutputExists)
        {
            OutputFormat = CandidateFormat;
            OutMimeType = ResolveRecordingMimeType(CandidateFormat);
            OutFilePath = CandidateOutputPath;
            ReturnCode = CandidateReturnCode;
            StdOut = CandidateStdOut;
            StdErr = CandidateStdErr;
            return true;
        }

        UE_LOG(
            LogTemp,
            Warning,
            TEXT("HMDao Unreal Capture: ffmpeg attempt failed. format=%s output=%s code=%d stdout=%s stderr=%s"),
            *CandidateFormat,
            *CandidateOutputPath,
            CandidateReturnCode,
            *CandidateStdOut,
            *CandidateStdErr);
        ReturnCode = CandidateReturnCode;
        StdOut = CandidateStdOut;
        StdErr = CandidateStdErr;
        return false;
    };

    bool bEncoded = false;
    if (OutputFormat == TEXT("webm"))
    {
        bEncoded = TryEncode(
            TEXT("webm"),
            OutFilePath,
            TEXT("-c:v libvpx-vp9 -pix_fmt yuv420p -row-mt 1 -b:v 0 -crf 30 "));
    }

    if (!bEncoded)
    {
        const FString Mp4OutputPath = FPaths::Combine(Recording.SessionDirectory, TEXT("recording.mp4"));
        bEncoded = TryEncode(
            TEXT("mp4"),
            Mp4OutputPath,
            TEXT("-c:v libopenh264 -pix_fmt yuv420p -movflags +faststart "));
    }
    if (!bEncoded)
    {
        const FString Mp4OutputPath = FPaths::Combine(Recording.SessionDirectory, TEXT("recording.mp4"));
        bEncoded = TryEncode(
            TEXT("mp4"),
            Mp4OutputPath,
            TEXT("-c:v h264_nvenc -pix_fmt yuv420p -movflags +faststart "));
    }
    if (!bEncoded)
    {
        const FString Mp4OutputPath = FPaths::Combine(Recording.SessionDirectory, TEXT("recording.mp4"));
        bEncoded = TryEncode(
            TEXT("mp4"),
            Mp4OutputPath,
            TEXT("-c:v libx264 -pix_fmt yuv420p -movflags +faststart "));
    }
    if (!bEncoded)
    {
        const FString Mp4OutputPath = FPaths::Combine(Recording.SessionDirectory, TEXT("recording.mp4"));
        bEncoded = TryEncode(
            TEXT("mp4"),
            Mp4OutputPath,
            TEXT("-c:v mpeg4 -pix_fmt yuv420p -movflags +faststart "));
    }

    if (!bEncoded || !FPaths::FileExists(OutFilePath))
    {
        UE_LOG(LogTemp, Warning, TEXT("HMDao Unreal Capture: ffmpeg encode failed. code=%d stdout=%s stderr=%s"), ReturnCode, *StdOut, *StdErr);
        return false;
    }

    TArray<FString> FrameFiles;
    IFileManager::Get().FindFiles(FrameFiles, *FPaths::Combine(Recording.SessionDirectory, TEXT("frame-*.*")), true, false);
    for (const FString& FrameFile : FrameFiles)
    {
        IFileManager::Get().Delete(*FPaths::Combine(Recording.SessionDirectory, FrameFile), false, true, true);
    }

    OutSizeBytes = IFileManager::Get().FileSize(*OutFilePath);
    Recording.OutputFormat = OutputFormat;
    Recording.OutputFilePath = OutFilePath;
    return OutSizeBytes > 0;
}

void FHMDaoUnrealCaptureModule::HandleMessage(const FString& Message)
{
    TSharedPtr<FJsonObject> Json;
    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Message);
    if (!FJsonSerializer::Deserialize(Reader, Json) || !Json.IsValid())
    {
        return;
    }

    const FString Type = ReadStringField(Json, TEXT("type"));
    if (Type == TEXT("hello_ack") || Type == TEXT("pong"))
    {
        LastPongAt = FPlatformTime::Seconds();
        return;
    }

    if (Type == TEXT("query_state"))
    {
        SendHello();
        SendCameraList();
        SendTimeline();
        FlushPendingRecordingNotice();
        return;
    }
    if (Type == TEXT("query_cameras"))
    {
        SendCameraList();
        return;
    }
    if (Type == TEXT("query_timeline") || Type == TEXT("query_animation_range"))
    {
        SendTimeline();
        return;
    }

    const FString CameraId = ReadStringField(Json, TEXT("cameraId"), ReadStringField(Json, TEXT("camera_id")));
    const FString CameraName = ReadStringField(Json, TEXT("cameraName"), ReadStringField(Json, TEXT("camera_name")));
    if (!CameraId.IsEmpty())
    {
        SelectedCameraId = CameraId;
        if (!CameraName.IsEmpty())
        {
            SelectedCameraName = CameraName;
        }
        ResolveSelectedCamera();
    }
    else if (!CameraName.IsEmpty())
    {
        SelectedCameraName = CameraName;
        ResolveSelectedCamera();
    }

    if (Type == TEXT("set_camera"))
    {
        if (FSceneCameraInfo CameraInfo = ResolveSelectedCamera(); CameraInfo.IsValid())
        {
            SyncViewportToSelectedCamera(CameraInfo);
        }
        SendCameraList();
        SendTimeline();
        SendFrame();
        return;
    }

    if (Type == TEXT("start_preview"))
    {
        ApplyPreviewRequest(Json);
        SendFrame();
        return;
    }

    if (Type == TEXT("stop_preview"))
    {
        bPreviewStreamingEnabled = false;
        return;
    }

    if (Type == TEXT("capture"))
    {
        const int32 Width = FMath::Clamp(ReadIntField(Json, TEXT("width"), ReadIntField(Json, TEXT("w"), PreviewWidth)), 64, 4096);
        const int32 Height = FMath::Clamp(ReadIntField(Json, TEXT("height"), ReadIntField(Json, TEXT("h"), PreviewHeight)), 64, 4096);
        const int32 Quality = FMath::Clamp(ReadIntField(Json, TEXT("quality"), 95), 1, 100);
        const FString Format = ReadStringField(Json, TEXT("format"), TEXT("png"));

        FString Payload;
        FString MimeType;
        int32 CapturedWidth = 0;
        int32 CapturedHeight = 0;
        const bool bCaptured = CaptureFromSelectedCamera(Width, Height, Format, Quality, Payload, MimeType, CapturedWidth, CapturedHeight);
        if (!bCaptured)
        {
            UE_LOG(LogTemp, Warning, TEXT("HMDao Unreal Capture: still capture failed for %s"), SelectedCameraName.IsEmpty() ? TEXT("<none>") : *SelectedCameraName);
            const TSharedRef<FJsonObject> ErrorObject = MakeShared<FJsonObject>();
            SetString(ErrorObject, TEXT("type"), TEXT("error"));
            SetString(ErrorObject, TEXT("message"), TEXT("Unreal failed to capture the current camera frame."));
            Socket->Send(ToJson(ErrorObject));
            return;
        }

        const TSharedRef<FJsonObject> Object = MakeShared<FJsonObject>();
        SetString(Object, TEXT("type"), TEXT("capture_done"));
        const TSharedRef<FJsonObject> Asset = MakeShared<FJsonObject>();
        SetString(Asset, TEXT("kind"), TEXT("image"));
        SetString(Asset, TEXT("mimeType"), MimeType);
        Asset->SetNumberField(TEXT("width"), CapturedWidth);
        Asset->SetNumberField(TEXT("height"), CapturedHeight);
        SetString(Asset, TEXT("cameraName"), SelectedCameraName.IsEmpty() ? TEXT("Editor Viewport") : SelectedCameraName);
        SetString(Asset, TEXT("cameraId"), SelectedCameraId);
        SetString(Asset, TEXT("payload"), Payload);
        Object->SetObjectField(TEXT("asset"), Asset);
        Socket->Send(ToJson(Object));
        return;
    }

    if (Type == TEXT("start_recording"))
    {
        BeginRecording(Json);
        return;
    }

    if (Type == TEXT("stop_recording"))
    {
        if (Recording.bActive && Recording.CapturedFrameCount > 0)
        {
            const int32 CompletedFrames = FMath::Max(1, Recording.CapturedFrameCount);
            const int32 DurationMs = FMath::Max(1, FMath::RoundToInt((static_cast<double>(CompletedFrames) / static_cast<double>(FMath::Max(1, Recording.Fps))) * 1000.0));
            SendRecordingDone(
                Recording.CapturedWidth > 0 ? Recording.CapturedWidth : PreviewWidth,
                Recording.CapturedHeight > 0 ? Recording.CapturedHeight : PreviewHeight,
                DurationMs);
            StopRecording(false);
            return;
        }
        StopRecording();
        return;
    }

    if (Type == TEXT("disconnect"))
    {
        bConnectRequested = false;
        Disconnect();
        StartBootstrapTicker();
        StopRuntimeTicker();
    }
}

IMPLEMENT_MODULE(FHMDaoUnrealCaptureModule, HMDaoUnrealCapture)











