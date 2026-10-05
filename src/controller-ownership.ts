import {mkdir,lstat,realpath,readdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

// Manager leases coordinate one controller. This outer ownership guard keeps a
// second local process from recovering or writing the first one's live state.
export async function acquireControllerOwnership(dataDir: string): Promise<() => Promise<void>>{
  await mkdir(resolve(dataDir),{recursive:true,mode:0o700});
  const directory=join(await realpath(resolve(dataDir)),'.controller-owners');
  await mkdir(directory,{mode:0o700,recursive:true});
  const info=await lstat(directory);
  if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Controller ownership storage must be a regular directory.');
  const name=`${process.pid}-${randomUUID()}.lock`,file=join(directory,name);
  await writeFile(file,'',{flag:'wx',mode:0o600});
  let releasing: Promise<void>|null|undefined;
  const release=()=>releasing??=(async()=>{try{await rm(file,{force:true});}catch(error){releasing=null;throw error;}})();
  try{
    // Every contender publishes BEFORE looking for other owners. If starts
    // overlap both may refuse, but neither can pass a live published contender.
    // Each filename is immutable and unique: stale cleanup never unlinks a
    // replacement owner's record, unlike reclaiming a shared fixed lock file.
    for(const entry of await readdir(directory)){
      // A hidden file, such as the one a file manager leaves in a folder it shows, is no record.
      if(entry===name||entry.startsWith('.'))continue;
      const match=/^([1-9]\d*)-[a-f0-9-]{36}\.lock$/.exec(entry);
      if(!match)throw new Error('Unrecognized controller ownership record; preserve the data directory.');
      const pid=Number(match[1]);let alive=true;
      if(!Number.isSafeInteger(pid)||pid>2147483647)throw new Error('Invalid controller ownership record; preserve the data directory.');
      try{process.kill(pid,0);}catch(error){const code=(error as NodeJS.ErrnoException).code;if(code==='ESRCH')alive=false;else if(code!=='EPERM')throw error;}
      // A process with the recorded id may not be a controller at all, after a crash and a reboot: say how to recover.
      if(alive)throw Object.assign(new Error(`Another local controller (process ${pid}) is already using this data directory. Close it or choose a different --data directory; if no controller is running, remove ${join(directory,entry)}.`),{code:'CONTROLLER_ALREADY_RUNNING'});
      await rm(join(directory,entry),{force:true});
    }
    return release;
  }catch(error){await release();throw error;}
}
