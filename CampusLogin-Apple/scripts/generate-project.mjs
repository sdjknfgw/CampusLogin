// Generates a self-contained Xcode project without third-party packages.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectPath = path.join(root, 'CampusLogin.xcodeproj');
const id = label => crypto.createHash('sha256').update(label).digest('hex').slice(0, 24).toUpperCase();
const quote = value => JSON.stringify(value);
const objects = [];
const object = (key, body) => { objects.push(`${id(key)} = { ${body} };`); return id(key); };
const ref = key => id(key);
const sources = ['Core/PortalProfile.swift', 'Core/PortalProtocol.swift', 'Core/Configuration.swift', 'Core/LoginPolicy.swift',
    'App/Keychain.swift', 'App/LocalNetwork.swift', 'App/CampusModel.swift',
    'App/ContentView.swift', 'App/CampusLoginApp.swift'];
const files = [...sources, 'Config/iOS-Info.plist', 'Config/macOS-Info.plist',
    'Config/macOS.entitlements', 'Resources/Assets.xcassets', 'Resources/PrivacyInfo.xcprivacy'];
for (const file of files) {
    if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing ${file}`);
    const type = file.endsWith('.swift') ? 'sourcecode.swift'
        : file.endsWith('.xcassets') ? 'folder.assetcatalog' : 'text.plist.xml';
    object(`file:${file}`, `isa = PBXFileReference; lastKnownFileType = ${quote(type)}; path = ${quote(file)}; sourceTree = "<group>";`);
}

const targets = [];
const products = [];
for (const platform of ['iOS', 'macOS']) {
    const name = `CampusLogin-${platform}`;
    const product = object(`product:${platform}`, `isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = CampusLogin.app; sourceTree = BUILT_PRODUCTS_DIR;`);
    products.push(product);
    const builds = sources.map(file => object(`build:${platform}:${file}`,
        `isa = PBXBuildFile; fileRef = ${ref(`file:${file}`)};`));
    const resources = ['Resources/Assets.xcassets', 'Resources/PrivacyInfo.xcprivacy'].map(file =>
        object(`build:${platform}:${file}`, `isa = PBXBuildFile; fileRef = ${ref(`file:${file}`)};`));
    object(`sources:${platform}`, `isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (${builds.join(',')}); runOnlyForDeploymentPostprocessing = 0;`);
    object(`resources:${platform}`, `isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (${resources.join(',')}); runOnlyForDeploymentPostprocessing = 0;`);
    object(`frameworks:${platform}`, 'isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;');
    const configs = [];
    for (const mode of ['Debug', 'Release']) {
        const settings = {
            PRODUCT_NAME: 'CampusLogin', PRODUCT_BUNDLE_IDENTIFIER: `com.campuslogin.app.${platform.toLowerCase()}`,
            SWIFT_VERSION: '5.0', MARKETING_VERSION: '1.0.5', CURRENT_PROJECT_VERSION: '1',
            CODE_SIGN_STYLE: 'Automatic', GENERATE_INFOPLIST_FILE: 'NO',
            INFOPLIST_FILE: `Config/${platform}-Info.plist`,
            ASSETCATALOG_COMPILER_APPICON_NAME: platform === 'iOS' ? 'AppIcon' : 'MacIcon',
            SWIFT_OPTIMIZATION_LEVEL: mode === 'Debug' ? '-Onone' : '-O',
            DEBUG_INFORMATION_FORMAT: mode === 'Debug' ? 'dwarf' : 'dwarf-with-dsym',
            SWIFT_ACTIVE_COMPILATION_CONDITIONS: mode === 'Debug' ? 'DEBUG' : '',
            ENABLE_TESTABILITY: mode === 'Debug' ? 'YES' : 'NO',
            ENABLE_USER_SCRIPT_SANDBOXING: 'YES',
            SDKROOT: platform === 'iOS' ? 'iphoneos' : 'macosx',
            SUPPORTED_PLATFORMS: platform === 'iOS' ? 'iphoneos iphonesimulator' : 'macosx',
            ...(platform === 'iOS' ? {
                IPHONEOS_DEPLOYMENT_TARGET: '16.0', TARGETED_DEVICE_FAMILY: '1,2',
                SUPPORTS_MACCATALYST: 'NO', LD_RUNPATH_SEARCH_PATHS: '$(inherited) @executable_path/Frameworks'
            } : {
                MACOSX_DEPLOYMENT_TARGET: '13.0', CODE_SIGN_ENTITLEMENTS: 'Config/macOS.entitlements',
                ENABLE_HARDENED_RUNTIME: 'YES', COMBINE_HIDPI_IMAGES: 'YES',
                LD_RUNPATH_SEARCH_PATHS: '$(inherited) @executable_path/../Frameworks'
            })
        };
        configs.push(object(`config:${platform}:${mode}`, `isa = XCBuildConfiguration; buildSettings = {
            ${Object.entries(settings).map(([k,v]) => `${k} = ${quote(v)};`).join('\n')}
        }; name = ${mode};`));
    }
    object(`configs:${platform}`, `isa = XCConfigurationList; buildConfigurations = (${configs.join(',')}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;`);
    targets.push(object(`target:${platform}`, `isa = PBXNativeTarget; name = ${quote(name)}; productName = CampusLogin;
        productReference = ${product}; productType = "com.apple.product-type.application";
        buildConfigurationList = ${ref(`configs:${platform}`)};
        buildPhases = (${ref(`sources:${platform}`)}, ${ref(`frameworks:${platform}`)}, ${ref(`resources:${platform}`)});
        buildRules = (); dependencies = ();`));
    fs.mkdirSync(path.join(projectPath, 'xcshareddata/xcschemes'), { recursive: true });
    const entry = `<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${ref(`target:${platform}`)}" BuildableName="CampusLogin.app" BlueprintName="${name}" ReferencedContainer="container:CampusLogin.xcodeproj"/>`;
    fs.writeFileSync(path.join(projectPath, `xcshareddata/xcschemes/${name}.xcscheme`), `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.3">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries>
    <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">${entry}</BuildActionEntry>
  </BuildActionEntries></BuildAction>
  <TestAction buildConfiguration="Debug" shouldUseLaunchSchemeArgsEnv="YES"/>
  <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">${entry}</BuildableProductRunnable></LaunchAction>
  <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">${entry}</BuildableProductRunnable></ProfileAction>
  <AnalyzeAction buildConfiguration="Debug"/>
  <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>\n`);
}
object('products', `isa = PBXGroup; children = (${products.join(',')}); name = Products; sourceTree = "<group>";`);
object('main', `isa = PBXGroup; children = (${files.map(f => ref(`file:${f}`)).join(',')}, ${ref('products')}); sourceTree = "<group>";`);
const projectConfigs = ['Debug', 'Release'].map(mode => object(`projectconfig:${mode}`,
    `isa = XCBuildConfiguration; buildSettings = { CLANG_ENABLE_MODULES = YES; CLANG_ENABLE_OBJC_ARC = YES; }; name = ${mode};`));
object('projectconfigs', `isa = XCConfigurationList; buildConfigurations = (${projectConfigs.join(',')}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;`);
object('project', `isa = PBXProject; attributes = { LastUpgradeCheck = 1600; BuildIndependentTargetsInParallel = YES; };
    buildConfigurationList = ${ref('projectconfigs')}; compatibilityVersion = "Xcode 14.0";
    developmentRegion = "zh-Hans"; hasScannedForEncodings = 0; knownRegions = ("zh-Hans", en, Base);
    mainGroup = ${ref('main')}; productRefGroup = ${ref('products')}; projectDirPath = ""; projectRoot = "";
    targets = (${targets.join(',')});`);
fs.writeFileSync(path.join(projectPath, 'project.pbxproj'), `// !$*UTF8*$!\n{
    archiveVersion = 1; classes = {}; objectVersion = 56;
    objects = {\n${objects.join('\n')}\n}; rootObject = ${ref('project')};
}\n`);
console.log('Generated CampusLogin.xcodeproj with iOS and macOS shared schemes.');
