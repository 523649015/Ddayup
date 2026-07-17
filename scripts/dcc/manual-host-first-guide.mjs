import path from 'node:path';

import { BlenderPluginAdapter } from '../../app/server/dcc/adapters/blender-plugin-adapter.mjs';
import { UnrealPluginAdapter } from '../../app/server/dcc/adapters/unreal-plugin-adapter.mjs';

const repoRoot = process.cwd();
const backupRoot = path.join(repoRoot, 'artifacts', 'backups');

function printSection(title) {
  console.log(`\n[${title}]`);
}

function printLine(label, value) {
  console.log(`${label}: ${value}`);
}

async function run() {
  const unrealPluginSource = path.join(repoRoot, 'plugins', 'unreal', 'HMDaoUnrealCapture');
  const blenderAddonSource = path.join(repoRoot, 'plugins', 'blender', 'hmdao_blender_capture');

  const unreal = new UnrealPluginAdapter({
    repoRoot,
    backupRoot,
    getBridgeState: () => ({}),
  });
  const blender = new BlenderPluginAdapter({
    repoRoot,
    backupRoot,
  });

  const [unrealStatus, blenderStatus] = await Promise.all([
    unreal.getStatus(),
    blender.getStatus(),
  ]);

  const unrealProject = unrealStatus.project;
  const unrealPlugin = unrealStatus.plugin || {};
  const unrealEngineRoot = unrealStatus.host?.engineInstalls?.[0]?.engineRoot || '';
  const unrealEditor = unrealEngineRoot ? unreal.resolveEditorExecutable(unrealEngineRoot) : '';
  const blenderInstallation = blender.pickInstallation(blenderStatus, '');
  const blenderVersions = Array.isArray(blenderStatus.host?.versions) ? blenderStatus.host.versions : [];

  console.log('HMDao Manual Host-First Guide');
  console.log('='.repeat(48));
  console.log('Goal: avoid automatic host startup, let the user open Unreal / Blender manually first, then let HMDao connect on demand.');

  printSection('Unreal');
  if (!unrealProject?.path || !unrealEditor) {
    console.log('Unreal project or editor path was not detected.');
  } else {
    const enginePluginPath = unrealPlugin.enginePluginPath
      && unrealPlugin.enginePluginPath !== unrealPlugin.projectPluginPath
      ? unrealPlugin.enginePluginPath
      : '';
    const effectiveProjectPluginPath = unrealPlugin.projectPluginPath
      || (!enginePluginPath ? unrealPlugin.effectivePath || '' : '');
    printLine('Project', unrealProject.path);
    printLine('Editor', unrealEditor);
    printLine('Engine-level plugin', enginePluginPath || 'not detected');
    printLine('Project-local plugin', effectiveProjectPluginPath || 'none');
    printLine('RC startup policy', unrealStatus.official?.remoteControlStartupPolicy?.keepsStartupLight ? 'on-demand' : 'still auto-start capable');
    printLine('Pixel Streaming', unrealStatus.official?.livePreviewReady ? 'enabled' : 'disabled by default');
    printLine('Copy-only plugin source', unrealPluginSource);
    console.log('');
    console.log('1. Launch Unreal manually in a visible window:');
    console.log(`   "${unrealEditor}" "${unrealProject.path}"`);
    console.log('   If Unreal previously failed with a DDC writable-node or Zen fallback error, prefer this verified fallback launch instead:');
    console.log(`   "${unrealEditor}" "${unrealProject.path}" -ddc=InstalledNoZenLocalFallback`);
    console.log('2. In Unreal, open Plugins and confirm `HMDaoUnrealCapture` is enabled.');
    console.log('3. If Unreal prompts for plugin enablement or restart, accept it there instead of letting HMDao auto-launch through the blocked startup phase.');
    console.log('4. Once the editor UI is fully open, return to HMDao and click `Connect`.');
    console.log('5. HMDao will then use the running editor path first, which is the safest flow under QQPC / VBS interference.');
    console.log('6. Copy-only fallback: manually copy that source folder into the engine plugin path above, then enable it from the Unreal Plugin browser.');
  }

  printSection('Blender');
  if (!blenderInstallation?.executablePath) {
    console.log('Blender executable was not detected automatically.');
  } else {
    printLine('Executable', blenderInstallation.executablePath);
    printLine('Installed add-on profiles', blenderVersions.length ? blenderVersions.map((item) => item.version).join(', ') : 'none');
    printLine('Copy-only add-on source', blenderAddonSource);
    for (const version of blenderVersions) {
      printLine(`Add-on path ${version.version}`, version.addonPath);
    }
    console.log('');
    console.log('1. Launch Blender manually in a normal UI window:');
    console.log(`   "${blenderInstallation.executablePath}"`);
    console.log('   If normal Blender startup hangs or becomes Not Responding before HMDao even appears, verify the host with this clean-user-config fallback first:');
    console.log(`   "${blenderInstallation.executablePath}" --factory-startup`);
    console.log('2. In Blender, open Edit > Preferences > Add-ons and search for `HMDao Blender Capture` or `hmdao`.');
    console.log('3. Enable the add-on manually if it is not already checked.');
    console.log('4. In the 3D View sidebar, open the `HMDao` tab and click `Start HMDao Capture Service`.');
    console.log('5. Once Blender shows the service as started, return to HMDao and click `Connect` or refresh the DCC node preview.');
    console.log('6. Copy-only fallback: manually copy that source folder into one of the add-on paths above, then enable it from Blender Preferences.');
  }

  printSection('Why this path');
  console.log('- It keeps HMDao out of the host startup critical path.');
  console.log('- It lets the user see and handle any first-run dialogs, plugin prompts, or blocked security popups directly in the host UI.');
  console.log('- It still preserves the current lightweight defaults: engine-level Unreal plugin, on-demand Remote Control, and no default Pixel Streaming.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
