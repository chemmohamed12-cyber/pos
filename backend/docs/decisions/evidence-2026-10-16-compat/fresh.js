const path=require('path');const app='D:/DAII-SIM-1110/deploy/app';
const {Client}=require(app+'/node_modules/pg');
const {runMigrationsForDatabase}=require(app+'/dist/foundation/release-orchestration/company-migration-runner');
const TAGS=['core','sales','inventory','logistics','finance','hr','procurement','accounting','manufacturing','attendance','commission','payroll','targets'];
(async()=>{const cfg=(d)=>({host:'127.0.0.1',port:5546,username:'daii_biz_test',password:process.env.PW,database:d});
const a=new Client({host:'127.0.0.1',port:5546,user:'daii_biz_test',password:process.env.PW,database:'postgres'});await a.connect();
await a.query('DROP DATABASE IF EXISTS daii_test_biz_t98_fresh WITH (FORCE)');await a.query('CREATE DATABASE daii_test_biz_t98_fresh');await a.end();
const r1=await runMigrationsForDatabase(app,cfg('daii_test_biz_t98_fresh'),TAGS);console.log('FRESH INSTALL success=',r1.success,'ran=',r1.ranMigrationNames.length,r1.error||'');
const r2=await runMigrationsForDatabase(app,cfg('daii_test_biz_t98_fresh'),TAGS);console.log('SECOND RUN (duplicate-execution protection) success=',r2.success,'ran=',r2.ranMigrationNames.length);
const r3=await runMigrationsForDatabase(app,cfg('daii_test_biz_t98_sim_co'),TAGS);console.log('RERUN ON UPGRADED COMPANY DB success=',r3.success,'ran=',r3.ranMigrationNames.length);
const c=new Client({host:'127.0.0.1',port:5546,user:'daii_biz_test',password:process.env.PW,database:'daii_test_biz_t98_fresh'});await c.connect();
const n=(await c.query('select count(*)::int n from migrations')).rows[0].n;console.log('fresh migrations table rows=',n);await c.end();})().catch(e=>console.log('ERR',e.message))
