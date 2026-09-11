using UnrealBuildTool;

public class HMDaoUnrealCaptureBootstrap : ModuleRules
{
    public HMDaoUnrealCaptureBootstrap(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.NoPCHs;
        PrecompileForTargets = PrecompileTargetsType.Editor;

        PublicDependencyModuleNames.AddRange(new string[]
        {
            "Core",
            "HTTP",
            "WebSockets"
        });
    }
}
