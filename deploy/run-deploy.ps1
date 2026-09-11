# deploy/run-deploy.ps1 - 本地 Windows 一键部署到 CentOS 服务器（需先配好 SSH 免密）
# 用法（PowerShell，管理员与否均可）：
#   powershell -File deploy/run-deploy.ps1
#
# 前置：
#   1. 已生成本机密钥（默认 $env:USERPROFILE\.ssh\id_ed25519）
#   2. 已将公钥推到服务器（否则本脚本会提示并退出）：
#      type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@43.139.15.112 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
#   3. 域名 A 记录已指向 43.139.15.112；腾讯云轻量防火墙已放行 80/443

$Server = "43.139.15.112"
$User   = "root"
$RemoteDir = "/opt/ddayup"
$LocalRoot = "f:\Work\HMDAODAO"
$Log    = "f:\Work\HMDAODAO\.deploy-log.txt"

function L($m){ $m | Tee-Object -Append -FilePath $Log; Write-Host $m }

L "=== deploy start $(Get-Date) ==="

# 1. 验证免密
$ok = ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 ${User}@${Server} "echo SSH_OK" 2>&1
if ($ok -notmatch "SSH_OK") {
  L "免密未生效！请先在 PowerShell 手动执行："
  L ('type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh {0}@{1} "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"' -f $User, $Server)
  L "（提示输入密码时填服务器 root 密码）"
  exit 1
}

# 2. 打包（排除 node_modules / .git，Windows 的 node_modules 在 Linux 上不可用）
L "打包..."
Push-Location $LocalRoot
tar -czf ddayup.tar.gz --exclude=node_modules --exclude=.git -C $LocalRoot HMDAODAO
Pop-Location
L ("打包完成 {0} bytes" -f (Get-Item "$LocalRoot\ddayup.tar.gz").Length)

# 3. 上传
L "上传中（1Mbps 可能需几分钟，请耐心）..."
scp ddayup.tar.gz ${User}@${Server}:/tmp/

# 4. 解压 + 部署（centos-deploy.sh 会装 Node/pm2/Caddy、build、申请证书、启动）
L "解压并部署..."
ssh ${User}@${Server} 'mkdir -p /opt/ddayup && tar -xzf /tmp/ddayup.tar.gz -C /opt && rm -rf /opt/ddayup && mv /opt/HMDAODAO /opt/ddayup && cd /opt/ddayup && bash deploy/centos-deploy.sh' 2>&1 | ForEach-Object { L $_ }

# 5. 验证
L "验证本地健康..."
$h = ssh ${User}@${Server} "curl -k -s https://127.0.0.1/api/health" 2>&1
L "health: $h"
L "=== end $(Get-Date) ==="
L "完成。外网请浏览器打开 https://mingmingchuangyi.cn 验证；日志见 $Log"
