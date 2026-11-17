// Adds the share extension to the iOS project (ios/App/App.xcodeproj): the
// ShareExtension target (ios/App/ShareExtension), embedded in the app, both
// in one app group so the extension can leave what was shared for the app;
// and the app's own plugin files (MainViewController, ShareTargetPlugin).
// Run after `cap add ios`; running it again changes nothing.
//
// It edits project.pbxproj as text: the xcodeproj gem that ships with macOS
// cannot read a project with a local Swift package, which Capacitor's is.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(dirname(fileURLToPath(import.meta.url))), 'ios/App');
const projectFile = join(root, 'App.xcodeproj/project.pbxproj');
const plistFile = join(root, 'App/Info.plist');
if (!existsSync(projectFile)) {
  console.log('no iOS project (run `cap add ios` first)');
  process.exit(0);
}
let text = readFileSync(projectFile, 'utf8');

const appId = /PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/.exec(text)?.[1];
const displayName = /<key>CFBundleDisplayName<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(plistFile, 'utf8'))?.[1];
if (!appId || !displayName) throw new Error('could not read the app’s bundle id or name');
const group = `group.${appId}`;
const quote = (value) => (/^[A-Za-z0-9_./]+$/.test(value) ? value : JSON.stringify(value));

/** A stable object id for a label, so a second run finds what the first added. */
const id = (label) => createHash('sha1').update(`share-extension:${label}`).digest('hex').slice(0, 24).toUpperCase();

const ORDER = [
  'PBXBuildFile', 'PBXContainerItemProxy', 'PBXCopyFilesBuildPhase', 'PBXFileReference', 'PBXFrameworksBuildPhase', 'PBXGroup',
  'PBXNativeTarget', 'PBXProject', 'PBXResourcesBuildPhase', 'PBXSourcesBuildPhase', 'PBXTargetDependency', 'PBXVariantGroup',
  'XCBuildConfiguration', 'XCConfigurationList',
];

function addToSection(section, entries) {
  const end = `/* End ${section} section */`;
  if (text.includes(end)) {
    text = text.replace(end, `${entries}${end}`);
    return;
  }
  // A new section goes before the next one that exists.
  const next = ORDER.slice(ORDER.indexOf(section) + 1).find((name) => text.includes(`/* Begin ${name} section */`));
  const anchor = next ? `/* Begin ${next} section */` : '\t};\n\trootObject';
  text = text.replace(anchor, `/* Begin ${section} section */\n${entries}${end}\n\n${anchor}`);
}

/** Where the object with this id is defined (not where a list names it). */
function definition(objectId) {
  const match = new RegExp(`\\n\\t\\t${objectId} [^\\n]*= \\{\\n`).exec(text);
  if (!match) throw new Error(`no object ${objectId}`);
  return match.index;
}

/** Adds a line to a list (`key = (`) of the object with this id. */
function addToList(objectId, key, line, { last = false } = {}) {
  const start = definition(objectId);
  const at = text.indexOf(`${key} = (\n`, start);
  const insert = last ? text.indexOf('\t\t\t);', at) : at + `${key} = (\n`.length;
  text = `${text.slice(0, insert)}${line}\n${text.slice(insert)}`;
}

/** Adds settings to every configuration of a configuration list. */
function addSettings(listId, settings) {
  const list = new RegExp(`\\t\\t${listId} [^\\n]*= \\{[\\s\\S]*?buildConfigurations = \\(([\\s\\S]*?)\\);`).exec(text);
  for (const [, configId] of list[1].matchAll(/([0-9A-F]{24})/g)) {
    for (const [key, value] of Object.entries(settings)) {
      const start = definition(configId);
      const block = text.indexOf('buildSettings = {\n', start) + 'buildSettings = {\n'.length;
      const end = text.indexOf('\t\t\t};', block);
      if (text.slice(block, end).includes(`\t${key} = `)) continue;
      text = `${text.slice(0, block)}\t\t\t\t${key} = ${quote(value)};\n${text.slice(block)}`;
    }
  }
}

const projectId = /rootObject = ([0-9A-F]{24})/.exec(text)[1];
const appTarget = /\t\t([0-9A-F]{24}) \/\* App \*\/ = \{\n\t\t\tisa = PBXNativeTarget;/.exec(text)[1];
const appConfigs = new RegExp(`\\t\\t${appTarget} [\\s\\S]*?buildConfigurationList = ([0-9A-F]{24})`).exec(text)[1];
const appSources = /\t\t([0-9A-F]{24}) \/\* Sources \*\/ = \{\n\t\t\tisa = PBXSourcesBuildPhase;/.exec(text)[1];
const appGroup = /\t\t([0-9A-F]{24}) \/\* App \*\/ = \{\n\t\t\tisa = PBXGroup;/.exec(text)[1];
const productsGroup = /\t\t([0-9A-F]{24}) \/\* Products \*\/ = \{\n\t\t\tisa = PBXGroup;/.exec(text)[1];
const mainGroup = /mainGroup = ([0-9A-F]{24});/.exec(text)[1];

// The app: its plugin files and the app group.
for (const name of ['MainViewController.swift', 'ShareTargetPlugin.swift']) {
  if (text.includes(`/* ${name} in Sources */`)) continue;
  addToSection('PBXFileReference', `\t\t${id(name)} /* ${name} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${name}; sourceTree = "<group>"; };\n`);
  addToSection('PBXBuildFile', `\t\t${id(`${name}:build`)} /* ${name} in Sources */ = {isa = PBXBuildFile; fileRef = ${id(name)} /* ${name} */; };\n`);
  addToList(appGroup, 'children', `\t\t\t\t${id(name)} /* ${name} */,`);
  addToList(appSources, 'files', `\t\t\t\t${id(`${name}:build`)} /* ${name} in Sources */,`);
}
if (!text.includes('/* App.entitlements */')) {
  addToSection('PBXFileReference', `\t\t${id('App.entitlements')} /* App.entitlements */ = {isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = App.entitlements; sourceTree = "<group>"; };\n`);
  addToList(appGroup, 'children', `\t\t\t\t${id('App.entitlements')} /* App.entitlements */,`);
}
addSettings(appConfigs, { CODE_SIGN_ENTITLEMENTS: 'App/App.entitlements', SHARE_APP_GROUP: group });

const plist = readFileSync(plistFile, 'utf8');
if (!plist.includes('<key>ShareAppGroup</key>')) {
  const at = plist.lastIndexOf('</dict>');
  writeFileSync(plistFile, `${plist.slice(0, at)}\t<key>ShareAppGroup</key>\n\t<string>$(SHARE_APP_GROUP)</string>\n${plist.slice(at)}`);
}

// The extension.
if (!text.includes('/* ShareExtension.appex */')) {
  const T = id('target');
  const files = {
    swift: id('ShareViewController.swift'),
    plist: id('ShareExtension/Info.plist'),
    entitlements: id('ShareExtension.entitlements'),
    product: id('ShareExtension.appex'),
  };
  addToSection(
    'PBXFileReference',
    [
      `\t\t${files.swift} /* ShareViewController.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ShareViewController.swift; sourceTree = "<group>"; };`,
      `\t\t${files.plist} /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };`,
      `\t\t${files.entitlements} /* ShareExtension.entitlements */ = {isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = ShareExtension.entitlements; sourceTree = "<group>"; };`,
      `\t\t${files.product} /* ShareExtension.appex */ = {isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; includeInIndex = 0; path = ShareExtension.appex; sourceTree = BUILT_PRODUCTS_DIR; };`,
      '',
    ].join('\n'),
  );
  addToSection(
    'PBXBuildFile',
    [
      `\t\t${id('ShareViewController.swift:build')} /* ShareViewController.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${files.swift} /* ShareViewController.swift */; };`,
      `\t\t${id('embed:build')} /* ShareExtension.appex in Embed Foundation Extensions */ = {isa = PBXBuildFile; fileRef = ${files.product} /* ShareExtension.appex */; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); }; };`,
      '',
    ].join('\n'),
  );
  addToSection(
    'PBXGroup',
    `\t\t${id('group')} /* ShareExtension */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t\t${files.swift} /* ShareViewController.swift */,\n\t\t\t\t${files.plist} /* Info.plist */,\n\t\t\t\t${files.entitlements} /* ShareExtension.entitlements */,\n\t\t\t);\n\t\t\tpath = ShareExtension;\n\t\t\tsourceTree = "<group>";\n\t\t};\n`,
  );
  addToList(mainGroup, 'children', `\t\t\t\t${id('group')} /* ShareExtension */,`);
  addToList(productsGroup, 'children', `\t\t\t\t${files.product} /* ShareExtension.appex */,`);

  const phase = (isa, label, extra = '') =>
    `\t\t${id(label)} /* ${label.split(':')[1]} */ = {\n\t\t\tisa = ${isa};\n\t\t\tbuildActionMask = 2147483647;\n${extra}\t\t\tfiles = (\n${label === 'ext:Sources' ? `\t\t\t\t${id('ShareViewController.swift:build')} /* ShareViewController.swift in Sources */,\n` : ''}\t\t\t);\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t};\n`;
  addToSection('PBXSourcesBuildPhase', phase('PBXSourcesBuildPhase', 'ext:Sources'));
  addToSection('PBXFrameworksBuildPhase', phase('PBXFrameworksBuildPhase', 'ext:Frameworks'));
  addToSection('PBXResourcesBuildPhase', phase('PBXResourcesBuildPhase', 'ext:Resources'));
  addToSection(
    'PBXCopyFilesBuildPhase',
    `\t\t${id('embed')} /* Embed Foundation Extensions */ = {\n\t\t\tisa = PBXCopyFilesBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tdstPath = "";\n\t\t\tdstSubfolderSpec = 13;\n\t\t\tfiles = (\n\t\t\t\t${id('embed:build')} /* ShareExtension.appex in Embed Foundation Extensions */,\n\t\t\t);\n\t\t\tname = "Embed Foundation Extensions";\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t};\n`,
  );

  const settings = {
    CODE_SIGN_ENTITLEMENTS: 'ShareExtension/ShareExtension.entitlements',
    CODE_SIGN_STYLE: 'Automatic',
    CURRENT_PROJECT_VERSION: '1',
    GENERATE_INFOPLIST_FILE: 'NO',
    INFOPLIST_FILE: 'ShareExtension/Info.plist',
    IPHONEOS_DEPLOYMENT_TARGET: '15.0',
    MARKETING_VERSION: '1.0',
    PRODUCT_BUNDLE_IDENTIFIER: `${appId}.share`,
    PRODUCT_NAME: '$(TARGET_NAME)',
    SHARE_APP_DISPLAY_NAME: displayName,
    SHARE_APP_GROUP: group,
    SKIP_INSTALL: 'YES',
    SWIFT_VERSION: '5.0',
    TARGETED_DEVICE_FAMILY: '1,2',
  };
  const config = (name) =>
    `\t\t${id(`config:${name}`)} /* ${name} */ = {\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = {\n${Object.entries(settings)
      .map(([key, value]) => `\t\t\t\t${key} = ${quote(value)};\n`)
      .join('')}\t\t\t\tLD_RUNPATH_SEARCH_PATHS = (\n\t\t\t\t\t"$(inherited)",\n\t\t\t\t\t"@executable_path/Frameworks",\n\t\t\t\t\t"@executable_path/../../Frameworks",\n\t\t\t\t);\n${name === 'Debug' ? '\t\t\t\tSWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;\n' : ''}\t\t\t};\n\t\t\tname = ${name};\n\t\t};\n`;
  addToSection('XCBuildConfiguration', config('Debug') + config('Release'));
  addToSection(
    'XCConfigurationList',
    `\t\t${id('configs')} /* Build configuration list for PBXNativeTarget "ShareExtension" */ = {\n\t\t\tisa = XCConfigurationList;\n\t\t\tbuildConfigurations = (\n\t\t\t\t${id('config:Debug')} /* Debug */,\n\t\t\t\t${id('config:Release')} /* Release */,\n\t\t\t);\n\t\t\tdefaultConfigurationIsVisible = 0;\n\t\t\tdefaultConfigurationName = Release;\n\t\t};\n`,
  );

  addToSection(
    'PBXNativeTarget',
    `\t\t${T} /* ShareExtension */ = {\n\t\t\tisa = PBXNativeTarget;\n\t\t\tbuildConfigurationList = ${id('configs')} /* Build configuration list for PBXNativeTarget "ShareExtension" */;\n\t\t\tbuildPhases = (\n\t\t\t\t${id('ext:Sources')} /* Sources */,\n\t\t\t\t${id('ext:Frameworks')} /* Frameworks */,\n\t\t\t\t${id('ext:Resources')} /* Resources */,\n\t\t\t);\n\t\t\tbuildRules = (\n\t\t\t);\n\t\t\tdependencies = (\n\t\t\t);\n\t\t\tname = ShareExtension;\n\t\t\tproductName = ShareExtension;\n\t\t\tproductReference = ${files.product} /* ShareExtension.appex */;\n\t\t\tproductType = "com.apple.product-type.app-extension";\n\t\t};\n`,
  );
  addToSection(
    'PBXContainerItemProxy',
    `\t\t${id('proxy')} /* PBXContainerItemProxy */ = {\n\t\t\tisa = PBXContainerItemProxy;\n\t\t\tcontainerPortal = ${projectId} /* Project object */;\n\t\t\tproxyType = 1;\n\t\t\tremoteGlobalIDString = ${T};\n\t\t\tremoteInfo = ShareExtension;\n\t\t};\n`,
  );
  addToSection(
    'PBXTargetDependency',
    `\t\t${id('dependency')} /* PBXTargetDependency */ = {\n\t\t\tisa = PBXTargetDependency;\n\t\t\ttarget = ${T} /* ShareExtension */;\n\t\t\ttargetProxy = ${id('proxy')} /* PBXContainerItemProxy */;\n\t\t};\n`,
  );
  // The app builds the extension first and copies it into PlugIns.
  addToList(appTarget, 'buildPhases', `\t\t\t\t${id('embed')} /* Embed Foundation Extensions */,`, { last: true });
  addToList(appTarget, 'dependencies', `\t\t\t\t${id('dependency')} /* PBXTargetDependency */,`);
  addToList(projectId, 'targets', `\t\t\t\t${T} /* ShareExtension */,`);
  text = text.replace('\t\t\t\tTargetAttributes = {\n', `\t\t\t\tTargetAttributes = {\n\t\t\t\t\t${T} = {\n\t\t\t\t\t\tCreatedOnToolsVersion = 26.3;\n\t\t\t\t\t};\n`);
}

writeFileSync(projectFile, text);
console.log(`share extension: ${appId}.share in ${group}`);
