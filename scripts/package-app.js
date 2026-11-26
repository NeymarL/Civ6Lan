const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {valid,lt} = require('semver');
const {version,build:metadata} = require('../package.json');

// When Electron supplies the Node runtime, treat the packaged archive as a file.
if (process.versions.electron) process.noAsar=true;

const exec = promisify(execFile);
const destination = path.resolve(__dirname,'../dist');
const macFolder = arch => arch==='arm64' ? 'mac-arm64' : 'mac';
const versionPart = /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.source;
const windowsName = new RegExp('^Civ6-LAN-'+versionPart+'-win-x64\\.(?:zip|exe)(?:\\.blockmap)?$');
const oldWindowsInstaller = new RegExp('^Civ6 LAN Setup '+versionPart+'\\.exe(?:\\.blockmap)?$');
const macName = new RegExp('^Civ6 LAN '+versionPart+'\\.app$');

async function prunePackages(directory, platform, arch, currentVersion, published) {
  const folder = platform==='mac' ? path.join(directory,macFolder(arch)) : directory;
  if (!(await fs.lstat(folder)).isDirectory()) throw new Error('Package output is not a directory.');
  for (const item of await fs.readdir(folder,{withFileTypes:true})) {
    const file = path.join(folder,item.name);
    if (file===published) continue;
    const match = platform==='mac'
      ? item.isDirectory() && macName.exec(item.name)
      : item.isFile() && (windowsName.exec(item.name) || oldWindowsInstaller.exec(item.name));
    const oldBundle = item.isDirectory() && (platform==='mac' && item.name===metadata.productName+'.app'
      || platform==='win' && item.name==='win-unpacked' && await fs.stat(path.join(file,metadata.productName+'.exe')).then(value=>value.isFile(),()=>false));
    if (oldBundle || (match && valid(match[1]) && lt(match[1],currentVersion))) {
      await fs.rm(file,{recursive:true,force:true});
      console.log('Removed old package:',path.relative(directory,file));
    }
  }
}

async function publish(source, target) {
  await fs.mkdir(path.dirname(target),{recursive:true});
  const backup = await fs.mkdtemp(path.join(path.dirname(target),'.previous-package-'));
  const saved = path.join(backup,path.basename(target));
  let moved = false;
  try {
    try {
      await fs.rename(target,saved);
      moved = true;
    } catch (error) {
      if (error.code!=='ENOENT') throw error;
    }
    await fs.rename(source,target);
  } catch (error) {
    if (moved) await fs.rename(saved,target);
    await fs.rm(backup,{recursive:true});
    throw error;
  }
  await fs.rm(backup,{recursive:true});
}

async function verifyMacBundle(bundle) {
  const verify = ()=>exec('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);
  try {
    await verify();
  } catch (_) {
    const {stderr} = await exec('/usr/bin/codesign',['-dv',bundle]);
    if (/^Authority=/m.test(stderr)) throw new Error('The signed macOS bundle failed verification.');
    await exec('/usr/bin/codesign',['--force','--deep','--sign','-','--preserve-metadata=entitlements,flags',bundle]);
    await verify();
  }
}

async function buildPackage(mode, archOption) {
  const {build,Platform,Arch} = require('electron-builder');
  const platform = mode==='local' ? {darwin:'mac',win32:'win'}[process.platform]
    : {mac:'mac',win:'win','win-zip':'win'}[mode];
  const arch = archOption ? archOption.slice(2) : platform==='mac' ? process.arch : 'x64';
  if (!platform || (archOption && !['--x64','--arm64'].includes(archOption))
    || !['arm64','x64'].includes(arch) || (platform==='win' && arch!=='x64')) {
    throw new Error('Choose mac [--arm64|--x64], win [--x64], win-zip [--x64], or local.');
  }
  const target = mode==='win' ? 'nsis' : mode==='win-zip' ? 'zip' : 'dir';
  const electronDist = process.env.CIV6_ELECTRON_DIST && path.resolve(process.env.CIV6_ELECTRON_DIST);
  if (electronDist && !(await fs.stat(electronDist)).isDirectory()) throw new Error('CIV6_ELECTRON_DIST must be a directory.');
  await fs.mkdir(destination,{recursive:true});
  if (!(await fs.lstat(destination)).isDirectory()) throw new Error('Package output is not a directory.');
  const staging = await fs.mkdtemp(path.join(destination,'.package-'));
  const config = {directories:{output:staging}};
  let unpacked;
  config.afterPack = ({appOutDir})=>{unpacked=appOutDir;};
  if (electronDist) config.electronDist=electronDist;
  if (platform==='win') {
    config.win={artifactName:'Civ6-LAN-'+version+'-win-x64.${ext}'};
    if (process.platform!=='win32' && target!=='nsis') config.win.signAndEditExecutable=false;
  }
  try {
    await build({
      targets:(platform==='mac' ? Platform.MAC : Platform.WINDOWS).createTarget([target],Arch[arch]),
      config,publish:'never'
    });
    const isMac = platform==='mac';
    const bundle = isMac ? path.join(unpacked,metadata.productName+'.app') : unpacked;
    const resources = path.join(bundle,isMac ? 'Contents/Resources' : 'resources');
    if (!(await fs.stat(path.join(resources,'app.asar'))).size) throw new Error('Packaged application is empty.');
    if (isMac) await verifyMacBundle(bundle);
    const source = target==='dir' ? bundle : path.join(staging,'Civ6-LAN-'+version+'-win-x64.'+(target==='zip' ? 'zip' : 'exe'));
    if (target!=='dir' && !(await fs.stat(source)).size) throw new Error('Installer or archive is empty.');
    if (target==='zip' && process.platform==='darwin') await exec('/usr/bin/unzip',['-tq',source]);
    const output = isMac
      ? path.join(destination,macFolder(arch),metadata.productName+' '+version+'.app')
      : path.join(destination,path.basename(source));
    await publish(source,output);
    if (target==='nsis') {
      for (const sidecar of [path.basename(source)+'.blockmap','latest.yml']) {
        const file = path.join(staging,sidecar);
        try {
          await fs.access(file);
        } catch (error) {
          if (error.code==='ENOENT') continue;
          throw error;
        }
        await publish(file,path.join(destination,sidecar));
      }
    }
    await prunePackages(destination,platform,arch,version,output);
    console.log('Package:',output);
  } finally {
    await fs.rm(staging,{recursive:true,force:true,maxRetries:3});
  }
}

if (require.main===module) {
  buildPackage(...process.argv.slice(2)).catch(error=>{
    console.error(error.message);
    process.exitCode=1;
  });
}

module.exports = {prunePackages};
