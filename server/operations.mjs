import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manualPdfBuffer } from './manual-pdf.mjs';

const docsDir=resolve(fileURLToPath(new URL('../docs/',import.meta.url)));
const documents=[['설계도','PORTAL_DESIGN.md'],['화면 디자인','PORTAL_UI_DESIGN.md'],['운영자 매뉴얼','OPERATOR_MANUAL.md']];

export function registerOperations(app,{db,requireRole,instanceId,selfCheck}){
 const admin=requireRole(['admin']);
 // 점검 로그: 문법 검사·자동 테스트·보안 점검 결과(최근 50회). 실행 중이면 진행 상황을 함께 돌려준다.
 app.get('/api/operations/checks',admin,(_req,res)=>res.json({running:selfCheck?.status()??null,logs:selfCheck?.logs()??[]}));
 app.post('/api/operations/checks',admin,(_req,res)=>{if(!selfCheck)throw Object.assign(new Error('이 실행 방식에서는 점검을 실행할 수 없습니다.'),{status:501});res.status(202).json({running:selfCheck.start('수동 실행')});});
 app.get('/api/operations',admin,(_req,res)=>{
  res.json({status:'running',instance_id:instanceId,started_at:new Date(Date.now()-process.uptime()*1000).toISOString(),
   uptime_seconds:Math.floor(process.uptime()),
   counts:{users:db.prepare('SELECT COUNT(*) n FROM users WHERE active=1').get().n,
    installations:db.prepare('SELECT COUNT(*) n FROM installations').get().n,
    projects:db.prepare('SELECT COUNT(*) n FROM projects').get().n,
    manuals:db.prepare('SELECT COUNT(*) n FROM manuals').get().n,
    work_logs:db.prepare('SELECT COUNT(*) n FROM work_logs').get().n},
   documents:documents.map(([title,name])=>({title,name,content:readFileSync(resolve(docsDir,name),'utf8'),pdf:name==='OPERATOR_MANUAL.md'?'/api/operations/manual.pdf':null}))});
 });
 // 운영자 매뉴얼 PDF: 요청할 때 docs/OPERATOR_MANUAL.md로 만들므로 문서를 고치면 바로 반영된다.
 app.get('/api/operations/manual.pdf',admin,async(_req,res)=>{
  const pdf=await manualPdfBuffer(readFileSync(resolve(docsDir,'OPERATOR_MANUAL.md'),'utf8'));
  res.set({'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="DYKIM-PORTAL-Operator-Manual.pdf"','Cache-Control':'no-store'});
  res.end(pdf);
 });
}
