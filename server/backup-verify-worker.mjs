// 백업 파일 무결성 검사를 별도 스레드에서 실행한다(큰 DB의 quick_check 동안 서버 응답이 멈추지 않도록).
import { parentPort, workerData } from 'node:worker_threads';
import { verifyBackup } from './backups.mjs';

try {
  verifyBackup(workerData.path);
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({ ok: false, message: error.message, status: error.status });
}
