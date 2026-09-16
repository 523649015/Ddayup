<#
.SYNOPSIS
    Edge 加载项更新 API 凭证（分类存储模板）

.DESCRIPTION
    ⚠️ 此文件专用于「一键上传」链路（update-edge-store.ps1 的链路 B），
       与「一键打包」(build-store-package.ps1) 完全无关，请单独分类保管。

    用法：
      1) 复制本文件为  edge-api-config.ps1  （已被 .gitignore 忽略，不会入库）
      2) 把微软下发的 ApiKey / ClientID 填到下面引号里
      3) 直接运行 .\update-edge-store.ps1 即可自动读取

    如何获取这两个值：见 EDGE_UPDATE_GUIDE.md 的「申请 ApiKey + ClientID」一节。
#>

# —— Edge 加载项发布 API 凭证（v1.1，由微软下发）——
$env:EDGE_ADDON_API_KEY    = ''   # 微软 Partner Center「发布 API」页面下发的 API 密钥
$env:EDGE_ADDON_CLIENT_ID  = ''   # 同一页面下发的客户端 ID
