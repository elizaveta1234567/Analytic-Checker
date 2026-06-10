#if UNITY_IOS
using System.IO;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.iOS.Xcode;
using UnityEngine;

/// <summary>
/// Enables iTunes/Finder document sharing for dev iOS builds so QA can pull analytics_live.log.
/// </summary>
public sealed class IosAnalyticsLogBridgePostProcessor : IPostprocessBuildWithReport
{
    public int callbackOrder => 999;

    public void OnPostprocessBuild(BuildReport report)
    {
        if (report.summary.platform != BuildTarget.iOS)
        {
            return;
        }

        if (!ShouldEnableFileSharing(report))
        {
            return;
        }

        var plistPath = Path.Combine(report.summary.outputPath, "Info.plist");
        if (!File.Exists(plistPath))
        {
            Debug.LogWarning("[AnalyticsLogBridge] Info.plist not found; skipping file-sharing keys.");
            return;
        }

        var plist = new PlistDocument();
        plist.ReadFromFile(plistPath);
        var root = plist.root;

        root.SetBoolean("UIFileSharingEnabled", true);
        root.SetBoolean("LSSupportsOpeningDocumentsInPlace", true);

        plist.WriteToFile(plistPath);
        Debug.Log("[AnalyticsLogBridge] Info.plist: UIFileSharingEnabled + LSSupportsOpeningDocumentsInPlace");
    }

    private static bool ShouldEnableFileSharing(BuildReport report)
    {
#if UNITY_EDITOR
        if (EditorUserBuildSettings.development)
        {
            return true;
        }

        var defines = PlayerSettings.GetScriptingDefineSymbolsForGroup(
            BuildPipeline.GetBuildTargetGroup(report.summary.platform));
        return defines.Contains("ANALYTICS_LOG_BRIDGE");
#else
        return false;
#endif
    }
}
#endif
