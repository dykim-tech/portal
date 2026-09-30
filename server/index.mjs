import { createPortal } from './app.mjs';
const portal=createPortal();
const port=Number(process.env.PORT??3000), host=process.env.HOST??'127.0.0.1';
const server=portal.app.listen(port,host,()=>{
  console.log(`Portal: ${process.env.APP_ORIGIN??'http://localhost:3000'}`);
  console.log(`First-run setup code, if needed: ${portal.tokenPath}`);
});
const timer=setInterval(()=>{try{portal.tick();}catch(error){console.error('Deadline scan failed',error);}},60000);
function close(){clearInterval(timer);server.close(()=>{portal.db.close();process.exit(0);});}
process.on('SIGTERM',close);process.on('SIGINT',close);
