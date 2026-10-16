// Test fixture: three Companies on the sim platform. A = good (288), B = will FAIL (conflicting column), C = good (288, must stay untouched after B fails).
const path=require('path');const APP='D:/DAII-SIM-1110/deploy/app';const nm=p=>require(path.join(APP,'node_modules',p));const R=p=>require(path.join(APP,'dist',p));
const {Client}=nm('pg');const {DataSource}=nm('typeorm');const {randomUUID}=require('crypto');
const PW=process.env.PW;const KEY='daii_dev_database_credential_encryption_key_do_not_use_in_prod';
const adminC=()=>new Client({host:'127.0.0.1',port:5546,user:'daii_biz_test',password:PW,database:'postgres'});
(async()=>{const a=adminC();await a.connect();
for(const n of ['co','co2','co3']){await a.query(`DROP DATABASE IF EXISTS daii_test_biz_t98_sim_${n} WITH (FORCE)`);await a.query(`CREATE DATABASE daii_test_biz_t98_sim_${n} TEMPLATE daii_test_biz_t98_sim_co_base`)}
await a.end();
const cp=new DataSource({type:'postgres',host:'127.0.0.1',port:5546,username:'daii_biz_test',password:PW,database:'daii_test_biz_t98_sim_cp',entities:[path.join(APP,'dist','**','*.entity.js')]});await cp.initialize();
await cp.query(`DELETE FROM database_credentials WHERE "databaseRegistryId" IN (SELECT id FROM database_registries WHERE "databaseName" IN ('daii_test_biz_t98_sim_co2','daii_test_biz_t98_sim_co3'))`);
await cp.query(`DELETE FROM database_registries WHERE "databaseName" IN ('daii_test_biz_t98_sim_co2','daii_test_biz_t98_sim_co3')`);
await cp.query(`UPDATE companies SET status='READY' WHERE name IN ('B-Fail','C-After')`);
await cp.query(`UPDATE companies SET name='A-Verify', status='READY' WHERE name IN ('Verify Co','A-Verify')`);
const {DatabaseRegistry}=R('foundation/database-registry/database-registry.entity');const {DatabaseCredential}=R('foundation/database-registry/database-credential.entity');
const {DatabaseRegistryService}=R('foundation/database-registry/database-registry.service');const {DatabaseCredentialCipherService}=R('foundation/database-registry/database-credential-cipher.service');
const reg=new DatabaseRegistryService(cp.getRepository(DatabaseRegistry),cp.getRepository(DatabaseCredential),new DatabaseCredentialCipherService({databaseCredentialEncryptionKey:KEY}));
for(const [nm2,db] of [['B-Fail','co2'],['C-After','co3']]){let ex=await cp.query(`SELECT id FROM companies WHERE name=$1`,[nm2]);let id=ex.length?ex[0].id:randomUUID();if(!ex.length)await cp.query(`INSERT INTO companies (id,"installationId",name,status) VALUES ($1,'installation',$2,'READY')`,[id,nm2]);
await reg.register({companyId:id,host:'127.0.0.1',port:5546,databaseName:'daii_test_biz_t98_sim_'+db,status:'ACTIVE'},JSON.stringify({username:'daii_biz_test',password:PW}))}
await cp.destroy();
const b=new Client({host:'127.0.0.1',port:5546,user:'daii_biz_test',password:PW,database:'daii_test_biz_t98_sim_co2'});await b.connect();await b.query('ALTER TABLE customers ADD COLUMN "partyType" text');await b.end();
console.log('fixture ready: A-Verify(co) good, B-Fail(co2) sabotaged (customers.partyType pre-exists), C-After(co3) good')})().catch(e=>{console.error('FIXTURE ERROR',e.message);process.exit(1)})
