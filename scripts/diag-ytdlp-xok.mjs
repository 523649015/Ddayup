// 复刻 hmdao-api.mjs:714 resolveYtDlpPath() 的逻辑，逐步定位为何返回 null
import fs from 'node:fs';
import { detectManagedLocalPostYtDlpPath } from '../app/server/lib/local-post-processing.mjs';

const managed = detectManagedLocalPostYtDlpPath();
console.log('1) detectManagedLocalPostYtDlpPath() =', JSON.stringify(managed));

if (managed) {
  console.log('2) existsSync =', fs.existsSync(managed));
  try {
    const st = fs.statSync(managed);
    console.log('   statSync.size  =', st.size);
    console.log('   statSync.mode  =', st.mode.toString(8));
    console.log('   statSync.isFile=', st.isFile());
  } catch (e) { console.log('   statSync 失败:', e.message); }

  // 逐个权限位测试（X_OK 是关键）
  for (const [name, flag] of [['F_OK', fs.constants.F_OK], ['R_OK', fs.constants.R_OK], ['W_OK', fs.constants.W_OK], ['X_OK', fs.constants.X_OK]]) {
    try {
      fs.accessSync(managed, flag);
      console.log(`   accessSync(${name}) = OK`);
    } catch (e) {
      console.log(`   accessSync(${name}) = FAIL (${e.code || e.message})`);
    }
  }
}

console.log('\n3) 结论');
console.log(managed ? '   detect 有值 → 若 X_OK 通过则 resolveYtDlpPath 应返回它' : '   detect 为空 → 安装目录配置与落位不一致');
