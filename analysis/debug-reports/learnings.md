# 排查学习要点（自动累积）

- 迅雷「分享态」(pan.xunlei.com/s/ + drive/v1/share + pass_code_token) 与「自己网盘」(pan.xunlei.com/?path= + drive/v1/files + 登录 Authorization) 是两套完全不同的 API/鉴权，网盘类功能必须按这两种形态分别实现，不能混用同一套解析路径。
- 扫描识别（DOM/URL 正则）与解析下载（API/被动捕获）应解耦：识别层用宽松正则覆盖所有页面形态，解析层按分享态/自己网盘分派。
- 自己网盘的 download_url 用 file_id 而非 share_id，且依赖登录 Cookie；排查"扫描不到"先查 NETDISK_RE 是否覆盖该 URL 形态。
- 排查"点了没反应"类问题：优先检查①是否卡在长超时等待；②是否所有分支返回空；③语法/括号不平衡导致整个文件不加载（参考 netdiskResolve 缺闭合 } 致 node --check 失败）。