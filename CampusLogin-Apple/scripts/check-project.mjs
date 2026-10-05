import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = fs.readFileSync(path.join(root, 'CampusLogin.xcodeproj/project.pbxproj'), 'utf8');
const tokens = project.replace(/\/\/[^\n]*/g, '').match(/"(?:\\.|[^"\\])*"|[A-Za-z0-9_.$<>/-]+|[{}()=;,]/g);
let offset = 0;
function consume(expected) {
    assert.equal(tokens[offset++], expected);
}
function parse() {
    const token = tokens[offset++];
    if (token === '{') {
        const result = {};
        while (tokens[offset] !== '}') {
            const key = parse(); consume('=');
            assert.ok(!Object.hasOwn(result, key), `Duplicate dictionary key ${key}`);
            result[key] = parse(); consume(';');
        }
        consume('}'); return result;
    }
    if (token === '(') {
        const values = [];
        while (tokens[offset] !== ')') {
            values.push(parse());
            if (tokens[offset] !== ')') consume(',');
        }
        consume(')'); return values;
    }
    assert.ok(token && !'{}()=;,'.includes(token), `Invalid token ${token}`);
    return token.startsWith('"') ? JSON.parse(token) : token;
}
const parsed = parse();
assert.equal(offset, tokens.length);
assert.equal(parsed.objects[parsed.rootObject].isa, 'PBXProject');
const objects = parsed.objects;
for (const object of Object.values(objects)) {
    for (const field of ['fileRef', 'productReference', 'buildConfigurationList', 'mainGroup', 'productRefGroup']) {
        if (object[field]) assert.ok(objects[object[field]], `Missing reference ${object[field]}`);
    }
    for (const field of ['children', 'files', 'targets', 'buildPhases', 'buildConfigurations']) {
        for (const reference of object[field] ?? []) assert.ok(objects[reference], `Missing list reference ${reference}`);
    }
    if (object.isa === 'PBXFileReference' && object.sourceTree === '<group>') {
        assert.ok(fs.existsSync(path.join(root, object.path)), `Missing source ${object.path}`);
    }
}
const targets = Object.values(objects).filter(o => o.isa === 'PBXNativeTarget');
assert.deepEqual(targets.map(t => t.name).sort(), ['CampusLogin-iOS', 'CampusLogin-macOS']);
for (const target of targets) {
    const sources = target.buildPhases.map(ref => objects[ref]).find(o => o.isa === 'PBXSourcesBuildPhase');
    assert.equal(sources.files.length, 9);
    const sourcePaths = sources.files.map(ref => objects[objects[ref].fileRef].path);
    assert.equal(new Set(sourcePaths).size, 9);
    const resources = target.buildPhases.map(ref => objects[ref]).find(o => o.isa === 'PBXResourcesBuildPhase');
    assert.ok(resources.files.some(ref => objects[objects[ref].fileRef].path === 'Resources/PrivacyInfo.xcprivacy'));
    const scheme = fs.readFileSync(path.join(root, `CampusLogin.xcodeproj/xcshareddata/xcschemes/${target.name}.xcscheme`), 'utf8');
    const targetRef = Object.keys(objects).find(ref => objects[ref] === target);
    assert.ok(scheme.includes(`BlueprintIdentifier="${targetRef}"`));
    const configs = objects[target.buildConfigurationList].buildConfigurations.map(ref => objects[ref]);
    for (const config of configs) {
        const plist = fs.readFileSync(path.join(root, config.buildSettings.INFOPLIST_FILE), 'utf8');
        assert.ok(plist.includes('NSLocalNetworkUsageDescription'));
        assert.ok(plist.includes('NSAllowsArbitraryLoads'));
    }
}
for (const name of ['AppIcon', 'MacIcon']) {
    const folder = path.join(root, `Resources/Assets.xcassets/${name}.appiconset`);
    const catalog = JSON.parse(fs.readFileSync(path.join(folder, 'Contents.json'), 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(catalog.images.length, name === 'AppIcon' ? 18 : 10);
    for (const entry of catalog.images) {
        const data = fs.readFileSync(path.join(folder, entry.filename));
        assert.equal(data.subarray(1, 4).toString(), 'PNG');
        const side = Number(entry.size.split('x')[0]) * Number(entry.scale.replace('x', ''));
        assert.equal(data.readUInt32BE(16), side);
        assert.equal(data.readUInt32BE(20), side);
        assert.equal(data[25], 2, 'Icons must be RGB without an alpha channel');
    }
}
console.log(`Validated ${Object.keys(objects).length} Xcode objects, both shared schemes, 18 source references and 28 RGB icons.`);
