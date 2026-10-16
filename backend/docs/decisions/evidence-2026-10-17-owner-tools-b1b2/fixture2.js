// Fresh Companies (no prior backups) R-One/R-Two on new DBs at 288; every other registry row set INACTIVE so the plan only sees these two.
const path=require('path');const APP='D:/DAII-SIM-1110/deploy/app';const nm=p=>require(path.join(APP,'node_modules',p));const R=p=>require(path.join(APP,'dist',p));
const {Client}=nm('pg');const {DataSource}=nm('typeorm');const {randomUUID}=require('crypto');const PW=process.env.PW;const KEY='daii_dev_database_credential_encryption_key_do_not_use_in_prod';const U=String(Date.now()).slice(-6);
(async()=>{const a=new Client({host:'127.0.0.1',port:5546,user:'daii_biz_test',password:PW,database:'postgres'});await a.connect();
const names=[`r${U}one`,`r${U}two`];for(const n of names){await a.query(`CREATE DATABASE daii_test_biz_t98_${n} TEMPLATE daii_test_biz_t98_sim_co_base`)}await a.end();
const cp=new DataSource({type:'postgres',host:'127.0.0.1',port:5546,username:'daii_biz_test',password:PW,database:'daii_test_biz_t98_sim_cp',entities:[path.join(APP,'dist','**','*.entity.js')]});await cp.initialize();
await cp.query(`UPDATE database_registries SET status='INACTIVE' WHERE "databaseName" NOT LIKE 'daii_test_biz_t98_r${U}%'`);
const {DatabaseRegistry}=R('foundation/database-registry/database-registry.entity');const {DatabaseCredential}=R('foundation/database-registry/database-credential.entity');
const {DatabaseRegistryService}=R('foundation/database-registry/database-registry.service');const {DatabaseCredentialCipherService}=R('foundation/database-registry/database-credential-cipher.service');
const reg=new DatabaseRegistryService(cp.getRepository(DatabaseRegistry),cp.getRepository(DatabaseCredential),new DatabaseCredentialCipherService({databaseCredentialEncryptionKey:KEY}));
for(const n of names){const id=randomUUID();await cp.query(`INSERT INTO companies (id,"installationId",name,status) VALUES ($1,'installation',$2,'READY')`,[id,n]);await reg.register({companyId:id,host:'127.0.0.1',port:5546,databaseName:'daii_test_biz_t98_'+n,status:'ACTIVE'},JSON.stringify({username:'daii_biz_test',password:PW}))}
await cp.destroy();console.log(names.map(n=>'daii_test_biz_t98_'+n).join(','))})().catch(e=>{console.error('FIX2 ERROR',e.message);process.exit(1)})
