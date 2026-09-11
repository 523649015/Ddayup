using UnrealBuildTool;

public class HMDaoUnrealCapture : ModuleRules
{
    public HMDaoUnrealCapture(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.NoPCHs;
        PrecompileForTargets = PrecompileTargetsType.Editor;

        PublicDependencyModuleNames.AddRange(new string[]
        {
            "Core",
            "CoreUObject",
            "Engine",
            "HTTP",
            "WebSockets",
            "Json",
            "JsonUtilities",
            "ImageWrapper"
        });

        PrivateDependencyModuleNames.AddRange(new string[]
        {
            "Slate",
            "SlateCore",
            "Sequencer",
            "UnrealEd",
            "LevelEditor",
            "LevelSequence",
            "MovieScene",
            "MovieSceneTracks",
            "RenderCore",
            "Projects"
        });
    }
}


