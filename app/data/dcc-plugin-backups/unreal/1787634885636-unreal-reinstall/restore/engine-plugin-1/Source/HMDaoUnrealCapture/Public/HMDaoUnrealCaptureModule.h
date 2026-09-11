#pragma once

#include "Containers/Ticker.h"
#include "CoreMinimal.h"
#include "Misc/QualifiedFrameTime.h"
#include "Modules/ModuleManager.h"
#include "Templates/SharedPointer.h"
#include "UObject/StrongObjectPtr.h"
#include "UObject/WeakObjectPtr.h"

class ISequencer;

class FHMDaoUnrealCaptureModule final : public IModuleInterface
{
public:
    virtual void StartupModule() override;
    virtual void ShutdownModule() override;

private:
    struct FSceneCameraInfo
    {
        TWeakObjectPtr<class AActor> Actor;
        TWeakObjectPtr<class UCameraComponent> CameraComponent;
        FString Id;
        FString Name;
        FString Label;

        bool IsValid() const
        {
            return Actor.IsValid() && CameraComponent.IsValid();
        }
    };

    struct FPendingRecordingNotice
    {
        bool bValid = false;
        FString RequestId;
        FString CameraName;
        FString CameraId;
        FString OutputFormat = TEXT("webm");
        FString OutputFilePath;
        FString OutputMimeType;
        int32 StartFrame = 1;
        int32 EndFrame = 1;
        int32 Fps = 24;
        int32 Width = 0;
        int32 Height = 0;
        int32 DurationMs = 0;
        int64 SizeBytes = 0;
    };

    struct FRecordingState
    {
        bool bActive = false;
        double StartedAt = 0.0;
        FString RequestId;
        FString OutputFormat = TEXT("webm");
        FString SessionDirectory;
        FString OutputFilePath;
        FString FrameFormat = TEXT("png");
        int32 StartFrame = 1;
        int32 EndFrame = 1;
        int32 Fps = 24;
        int32 LastAppliedFrame = TNumericLimits<int32>::Lowest();
        int32 CapturedFrameCount = 0;
        int32 CapturedWidth = 0;
        int32 CapturedHeight = 0;
        int32 CaptureWidth = 0;
        int32 CaptureHeight = 0;
        TWeakPtr<class ISequencer> EditorSequencer;
        TWeakObjectPtr<class ULevelSequencePlayer> SequencePlayer;
        FQualifiedFrameTime SavedEditorTime;
        bool bHasSavedEditorTime = false;
        FQualifiedFrameTime SavedTime;
        bool bHasSavedTime = false;
        bool bWasPlaying = false;
        // When true, recording drives the editor sequence by actually PLAYING it (real-time)
        // instead of manually scrubbing the playhead. This lets world-driven simulation
        // (Niagara/GPU particles, physics, gameplay/AnimBP skeletal meshes) advance in lockstep
        // with the sequence-bound tracks, so the captured clip is fully WYSIWYG.
        bool bPlaybackStarted = false;
        // Sequencer time is expressed in TICK resolution, while StartFrame/EndFrame are
        // DISPLAY frames. These cache the conversion so recording steps each display frame
        // to the correct tick time (fixes the "recorded video is static" bug where display
        // frame numbers were mistakenly used as tick values, collapsing every frame to t~0).
        FFrameRate TickResolution = FFrameRate(24000, 1);
        FFrameRate DisplayRate = FFrameRate(24, 1);
        bool bHasFrameRates = false;
        // Real tick-space bounds of the focused sequence (from TryGetEffectiveMovieSceneFrameBounds).
        // Recording steps the playhead by linearly mapping [StartFrame,EndFrame] onto this interval,
        // which is immune to a wrong project DisplayRate (e.g. 60000/1) producing a static clip.
        int32 SequenceStartTick = 0;
        int32 SequenceEndTick = 0;
        bool bHasSequenceTicks = false;
        // Wall-clock time (seconds) of the previous capture step. Used to advance the
        // editor world simulation by the real elapsed time between frames so that
        // world-driven systems (particles, hair, physics, gameplay skeletal) stay in
        // lockstep with the sequence-stepped camera.
        double LastTickWallClock = 0.0;
        // The editor sequencer we drive directly during recording (the SAME one the user
        // sees when they press Play in the Sequencer - so skeletal animation, particles and
        // physics all evaluate exactly as in the live viewport, WYSIWYG). We deliberately do
        // NOT spin up a separate ULevelSequencePlayer: that would spawn its own duplicate
        // actors ("extra objects" in the scene) and a standalone player does not drive the
        // editor's live spawnables/ Niagara systems the same way. Driving the editor
        // sequencer in place means zero extra objects are created - we only step the
        // playhead frame-by-frame and capture the camera view.
        TWeakPtr<class ISequencer> RecordingSequencer;
        // Open editor sequencers captured at recording start, with their times, so we can
        // restore their playback status/time after recording (we do NOT create players or
        // despawn their spawnables - we simply step the focused one in lockstep).
        TArray<TWeakPtr<class ISequencer>> OpenSequencersDuringRecord;
        TArray<FQualifiedFrameTime> OpenSequencerSavedTimes;
    };

    bool TickBootstrap(float DeltaTime);
    bool TickRuntime(float DeltaTime);
    void StartBootstrapTicker();
    void StopBootstrapTicker();
    void StartRuntimeTicker();
    void StopRuntimeTicker();
    bool IsEditorReadyForBridge() const;
    void Connect();
    void Disconnect();
    bool ShouldAttemptConnect() const;
    bool RefreshConnectIntent();
    FString GetConnectRequestFilePath() const;
    void ClearConnectRequestFile() const;
    void SendHello();
    void SendCameraList();
    void SendTimeline();
    void SendFrame();
    void HandleMessage(const FString& Message);

    class UWorld* GetEditorWorld() const;
    TArray<FSceneCameraInfo> GatherSceneCameras(class UWorld* World) const;
    FSceneCameraInfo ResolveViewportCamera() const;
    void SyncViewportToSelectedCamera(const FSceneCameraInfo& Camera) const;
    FSceneCameraInfo BuildCameraInfoFromComponent(class UCameraComponent* CameraComponent) const;
    FString DescribeCameraInfo(const FSceneCameraInfo& Camera) const;
    FString DescribeSequencerState(const TSharedPtr<class ISequencer>& Sequencer) const;
    TSharedPtr<class ISequencer> FindPreferredEditorSequencer() const;
    FSceneCameraInfo ResolveCameraFromSequencerCut(const TSharedPtr<class ISequencer>& Sequencer) const;
    // Resolves the camera bound to a sequence even when there is NO camera-cut track
    // (e.g. a camera animated purely via a transform track). This is what makes the
    // recorded/previewed shot follow the animated camera instead of freezing on the
    // static editor viewport.
    FSceneCameraInfo ResolveCameraFromSequencerBindings(const TSharedPtr<class ISequencer>& Sequencer) const;
    FSceneCameraInfo ResolveSelectedCamera();
    FSceneCameraInfo ResolveCaptureCamera();
    // Recording-specific camera resolver. Sequence-first (cut track, then any camera
    // bound to the sequence, then Level Sequence Player camera). When a sequence is
    // active but no camera can be resolved it returns invalid (so recording does NOT
    // silently fall back to the static editor viewport). When no sequence is active it
    // falls back to the explicitly selected camera / editor viewport.
    FSceneCameraInfo ResolveRecordingCamera();
    void UpdateSelectedCamera(const FSceneCameraInfo& Camera);
    void ApplyPreviewRequest(const TSharedPtr<class FJsonObject>& Json);
    bool CaptureFromSelectedCamera(int32 Width, int32 Height, const FString& RequestedFormat, int32 Quality, FString& OutPayload, FString& OutMimeType, int32& OutWidth, int32& OutHeight);
    bool CaptureFromSelectedCameraBytes(int32 Width, int32 Height, const FString& RequestedFormat, int32 Quality, TArray64<uint8>& OutBytes, FString& OutMimeType, int32& OutWidth, int32& OutHeight);
    bool CaptureFromCameraBytes(const FSceneCameraInfo& CameraInfo, int32 Width, int32 Height, const FString& RequestedFormat, int32 Quality, TArray64<uint8>& OutBytes, FString& OutMimeType, int32& OutWidth, int32& OutHeight);
    bool CaptureEditorViewport(int32 RequestedWidth, int32 RequestedHeight, int32 Quality, const FString& RequestedFormat, FString& OutPayload, FString& OutMimeType, int32& OutWidth, int32& OutHeight) const;
    bool CaptureEditorViewportBytes(int32 RequestedWidth, int32 RequestedHeight, int32 Quality, const FString& RequestedFormat, TArray64<uint8>& OutBytes, FString& OutMimeType, int32& OutWidth, int32& OutHeight) const;
    class ASceneCapture2D* EnsureCaptureActor(class UWorld* World);
    class UTextureRenderTarget2D* EnsureRenderTarget(int32 Width, int32 Height);
    bool QueryEditorSequencerTimeline(int32& OutStartFrame, int32& OutEndFrame, int32& OutCurrentFrame, int32& OutFps);
    bool QueryTimeline(int32& OutStartFrame, int32& OutEndFrame, int32& OutCurrentFrame, int32& OutFps);
    void BeginRecording(const TSharedPtr<class FJsonObject>& Json);
    void StopRecording(bool bNotifyStopped = true);
    void TickRecording(double Now);
    void SendRecordingDone(int32 Width, int32 Height, int32 DurationMs);
    bool SaveRecordingFrame(int32 FrameNumber);
    bool FinalizeRecordingOutput(int32 DurationMs, FString& OutFilePath, FString& OutMimeType, int64& OutSizeBytes);
    void FlushPendingRecordingNotice();
    // Temporarily enable tick-in-editor on every skeletal mesh in the level so that
    // AnimBP/gameplay-driven skeletal animation actually advances during a (deterministic)
    // recording step. Editor skeletal meshes do NOT tick by default (bTickInEditor=false),
    // which is why recorded clips freeze the skeleton. Restored with bEnable=false.
    void EnableSkeletalTickInEditor(bool bEnable);
    // Advances the recording by exactly one display frame: poses the sequence (skeletal
    // animation tracks / camera / everything bound to it) via SetLocalTimeDirectly +
    // ForceEvaluate, then ticks the editor world by 1/Fps so world-driven simulation
    // (Niagara particles, Groom/hair physics, fluid, physics) advances in lockstep. The
    // skeleton keeps its sequence-posed pose because bTickInEditor stays false. The captured
    // frame (SaveRecordingFrame) renders the camera viewport's final image, so the clip is
    // automatically WYSIWYG with what the camera sees during playback.
    void StepRecordingFrame(int32 DisplayFrame);

    TSharedPtr<class IWebSocket> Socket;
    FTSTicker::FDelegateHandle BootstrapTickHandle;
    FTSTicker::FDelegateHandle RuntimeTickHandle;
    FString SelectedCameraId;
    FString SelectedCameraName;
    int32 PreviewWidth = 1280;
    int32 PreviewHeight = 720;
    int32 PreviewFps = 15;
    int32 PreviewQuality = 82;
    FString PreviewFormat = TEXT("jpeg");
    bool bPreviewStreamingEnabled = false;
    bool bConnectRequested = false;
    double LastFrameSentAt = 0.0;
    double LastReconnectAt = 0.0;
    double LastConnectIntentCheckAt = 0.0;
    double LastPingAt = 0.0;
    double LastPongAt = 0.0;
    double LastTimelineReportAt = 0.0;
    bool bLastReportedHasSequence = false;
    bool bLastReportedHasCamera = false;
    double EditorReadySinceAt = 0.0;
    bool bSocketConnecting = false;
    bool bBridgeSessionSeen = false;
    TWeakObjectPtr<class ASceneCapture2D> CaptureActor;
    TStrongObjectPtr<class UTextureRenderTarget2D> RenderTarget;
    FRecordingState Recording;
    FPendingRecordingNotice PendingRecordingNotice;
};


