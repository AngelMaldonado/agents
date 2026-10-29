import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultHarness, validateHarness, runtimeToolNames, harnessInstructions } from '../../sandbox/harness';
import { fileDenial, textStats, jsonInfo } from '../../sandbox/harness-policy';
import { definition, proposalDigest, harnessHash } from './harnesses';
import { parseDesignReply } from './design-format';
test('manifest normalization is deterministic and preserves the legacy capability ceiling', () => {
 const h = defaultHarness(); expect(validateHarness(h)).toEqual(h);
 expect(runtimeToolNames(h)).toEqual(['bash','browser','edit','login','read','request_help','write']);
 expect(harnessHash({ ...h, tools: [...h.tools].reverse() })).toBe(harnessHash(h));
 expect(defaultHarness()).not.toBe(h);
});
test('rejects unknown capabilities, platform permission changes, executable plugins and ambiguous versions', () => {
 const h = defaultHarness();
 for (const value of [{ ...h, network: '*' }, { ...h, credentials: ['new'] }, { ...h, tools: [...h.tools, 'codemode'] }, { ...h, tools: ['read'] }, { ...h, plugins: [{ id:'text-utils',version:'latest' }] }, { ...h, plugins: [{id:'npm:untrusted',version:'1.0.0'}] }, { ...h, plugins: [{id:'text-utils',version:'1.0.0',code:'process.exit()'}] }, { ...h, restrictions: {...h.restrictions,quota:99} }]) expect(() => validateHarness(value)).toThrow();
});
test('rejects shell bypass of file restrictions and inconsistent read-only tools', () => {
 const h = defaultHarness();
 expect(() => validateHarness({...h,restrictions:{...h.restrictions,workspaceFilesOnly:true}})).toThrow('bash');
 expect(() => validateHarness({...h,restrictions:{...h.restrictions,readOnlyFiles:true}})).toThrow('bash');
 expect(() => validateHarness({...h,tools:h.tools.filter(t=>t!=='bash'),restrictions:{...h.restrictions,readOnlyFiles:true}})).toThrow('write');
 expect(validateHarness({...h,tools:['read','request_help'],restrictions:{...h.restrictions,workspaceFilesOnly:true,readOnlyFiles:true}}).restrictions.readOnlyFiles).toBe(true);
});
test('skills and guidelines are bounded data with safe names, not code or package references', () => {
 const h = defaultHarness(), skill={name:'research',description:'Revisar fuentes.',instructions:'## Pasos\nCompara citas.'};
 expect(validateHarness({...h,skills:[skill]}).skills).toEqual([skill]);
 for (const skills of [[{...skill,name:'../../escape'}],[skill,skill],[{...skill,instructions:'x'.repeat(8001)}],Array.from({length:5},(_,i)=>({...skill,name:`skill-${i}`})),[{...skill,script:'evil'}]]) expect(()=>validateHarness({...h,skills})).toThrow();
 expect(()=>validateHarness({...h,restrictions:{...h.restrictions,guidelines:['x'.repeat(501)]}})).toThrow();
 expect(harnessInstructions({...h,skills:[skill]})).toContain(skill.instructions);
});
test('file policy resolves symlinks, dangling links and new parents, and rejects read-only screenshots', () => {
 const dir=mkdtempSync(join(tmpdir(),'harness-policy-')), work=join(dir,'work'), outside=join(dir,'outside');
 mkdirSync(work); mkdirSync(outside); writeFileSync(join(outside,'secret'),'test');
 symlinkSync(outside,join(work,'link')); symlinkSync(join(outside,'missing'),join(work,'dangling'));
 const h=validateHarness({...defaultHarness(),tools:['read','write','request_help'],restrictions:{workspaceFilesOnly:true,readOnlyFiles:false,guidelines:[]}});
 try {
  for(const path of ['../outside/secret',join(work,'link','secret'),join(work,'link','new','file'),join(work,'dangling'),join(work,'dangling','child')]) expect(fileDenial(h,'write',{path},work,work)).not.toBeNull();
  expect(fileDenial(h,'write',{path:'nested/new.txt'},work,work)).toBeNull();
  expect(fileDenial(h,'ls',{},outside,work)).not.toBeNull();
  const ro=validateHarness({...h,tools:['read','request_help'],restrictions:{...h.restrictions,readOnlyFiles:true}});
  for(const name of ['write','edit','browser_screenshot']) expect(fileDenial(ro,name,{path:'out/x'},work,work)).toContain('lectura');
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('pinned pure plugins handle Unicode and invalid JSON without executing data', () => {
 expect(textStats('hola 👋\nmundo')).toEqual({characters:12,words:3,lines:2});
 expect(jsonInfo('{"a":1}')).toEqual({valid:true,type:'object',count:1});
 expect(jsonInfo('process.exit()').valid).toBe(false); expect(jsonInfo('null').type).toBe('null');
 const h=validateHarness({...defaultHarness(),plugins:[{id:'text-utils',version:'1.0.0'},{id:'json-utils',version:'1.0.0'}]});
 expect(runtimeToolNames(h)).toContain('text_stats'); expect(runtimeToolNames(h)).toContain('json_validate');
});
test('definition and approval digests bind model, contract, harness and the exact proposal revision', () => {
 const a={config_revision:3,name:'A',role:'Original',model:'openai/gpt-6-sol',harness:defaultHarness(),harness_image:'sha256:test'};
 const first=definition(a); a.role='Changed'; a.harness.skills.push({name:'new',description:'Nueva',instructions:'Pasos'});
 expect(first.role).toBe('Original'); expect(first.harness.skills).toEqual([]); expect(definition(a).digest).not.toBe(first.digest);
 const p={version:1,model:a.model,contract:{name:a.name,prompt:a.role},harness:a.harness};
 expect(proposalDigest({...p,version:2})).not.toBe(proposalDigest(p));
 expect(proposalDigest({...p,model:'openai/other'})).not.toBe(proposalDigest(p));
});
test('designer returns harness as validated data and cannot smuggle code or privileges into the proposal', () => {
 const reply=(h:unknown)=>({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({message:'Revisa',contract:{name:'A',prompt:'Rol'},harness:h,ready:true})}]}]});
 expect(parseDesignReply(reply(defaultHarness())).harness).toEqual(defaultHarness());
 expect(()=>parseDesignReply(reply({...defaultHarness(),plugins:[{id:'evil',version:'1.0.0'}]}))).toThrow();
});
