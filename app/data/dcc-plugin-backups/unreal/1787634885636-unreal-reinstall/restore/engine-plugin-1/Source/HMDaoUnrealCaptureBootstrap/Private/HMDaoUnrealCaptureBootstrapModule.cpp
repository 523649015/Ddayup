#include "CoreMinimal.h"
#include "Modules/ModuleInterface.h"
#include "Modules/ModuleManager.h"
#include "HttpModule.h"
#include "Misc/ScopeExit.h"
#include "WebSocketsModule.h"

namespace
{
constexpr const TCHAR* HMDaoUnrealWsUrl = TEXT("ws://127.0.0.1:8792/ws/dcc/unreal?role=plugin");
constexpr const TCHAR* HMDaoWebSocketsModuleName = TEXT("WebSockets");

bool IsLocalLoopbackBridgeUrl(const FString& Url)
{
    return Url.StartsWith(TEXT("ws://127.0.0.1"))
        || Url.StartsWith(TEXT("wss://127.0.0.1"))
        || Url.StartsWith(TEXT("ws://localhost"))
        || Url.StartsWith(TEXT("wss://localhost"))
        || Url.StartsWith(TEXT("ws://[::1]"))
        || Url.StartsWith(TEXT("wss://[::1]"));
}

void LoadWebSocketsForLocalBridge(FHttpModule& HttpModule, const FString& OriginalProxyAddress)
{
    const bool bShouldBypassProxyForLocalBridge = !OriginalProxyAddress.IsEmpty() && IsLocalLoopbackBridgeUrl(HMDaoUnrealWsUrl);
    ON_SCOPE_EXIT
    {
        if (bShouldBypassProxyForLocalBridge)
        {
            HttpModule.SetProxyAddress(OriginalProxyAddress);
            UE_LOG(LogTemp, Log, TEXT("HMDao Unreal Capture Bootstrap: restored HTTP proxy after early WebSockets init"));
        }
    };

    if (bShouldBypassProxyForLocalBridge)
    {
        UE_LOG(LogTemp, Log, TEXT("HMDao Unreal Capture Bootstrap: priming WebSockets early for local bridge without proxy '%s'"), *OriginalProxyAddress);
        HttpModule.SetProxyAddress(FString());
    }

    FWebSocketsModule::Get();
}

void PrimeWebSocketsForLocalBridge()
{
    FHttpModule& HttpModule = FHttpModule::Get();
    const FString OriginalProxyAddress = HttpModule.GetProxyAddress();
    const bool bNeedsLoopbackProxyBypass = !OriginalProxyAddress.IsEmpty() && IsLocalLoopbackBridgeUrl(HMDaoUnrealWsUrl);
    const bool bWebSocketsAlreadyLoaded = FModuleManager::Get().IsModuleLoaded(HMDaoWebSocketsModuleName);

    if (bWebSocketsAlreadyLoaded)
    {
        if (!bNeedsLoopbackProxyBypass)
        {
            return;
        }

        UE_LOG(LogTemp, Warning, TEXT("HMDao Unreal Capture Bootstrap: WebSockets already loaded with proxy '%s'; attempting early reload for loopback bridge"), *OriginalProxyAddress);
        if (!FModuleManager::Get().UnloadModule(HMDaoWebSocketsModuleName))
        {
            UE_LOG(LogTemp, Warning, TEXT("HMDao Unreal Capture Bootstrap: unable to unload WebSockets early; loopback bridge may still be proxied"));
            return;
        }

        LoadWebSocketsForLocalBridge(HttpModule, OriginalProxyAddress);
        UE_LOG(LogTemp, Log, TEXT("HMDao Unreal Capture Bootstrap: WebSockets reloaded successfully for local bridge"));
        return;
    }

    LoadWebSocketsForLocalBridge(HttpModule, OriginalProxyAddress);
}
}

class FHMDaoUnrealCaptureBootstrapModule final : public IModuleInterface
{
public:
    virtual void StartupModule() override
    {
        PrimeWebSocketsForLocalBridge();
    }
};

IMPLEMENT_MODULE(FHMDaoUnrealCaptureBootstrapModule, HMDaoUnrealCaptureBootstrap)
