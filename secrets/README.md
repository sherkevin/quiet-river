# secrets/

登录态凭证存放处。**本目录除本文件外全部被 `.gitignore` 忽略，绝不会进仓库。**

开源版本不带任何登录态适配器，所以这个目录默认是空的。它存在的意义是：如果你在
`lib/adapters.private.js`（同样被 gitignore）里为自己的机器写了适配器，凭证就放这里，
而不是写进代码。

## 约定

```js
const { readSecret } = require('../lib/secrets');
const cookie = readSecret('my-platform-cookie.txt', 'MY_PLATFORM_COOKIE');
```

`readSecret(file, envKey)` 先读环境变量，再读 `secrets/<file>`，两者都没有返回空串，
由适配器自己抛出可读的「缺凭证」提示。文件建议单行，权限收紧：

```bash
printf '%s' '<value>' > secrets/my-platform-cookie.txt
chmod 600 secrets/my-platform-cookie.txt
git check-ignore -v secrets/my-platform-cookie.txt   # 确认它真的被忽略
```

## 三条底线

- **只放自己的凭证。** 这是你登录态的等价物，泄露等于交出账号。
- **别把它写进代码或配置。** `data/subscriptions.json` 是要提交的文件，凭证进去就等于公开。
- **低频使用。** 登录态通道普遍有限流，读到 403 就停手退避，不要轮询，不要频繁重登
  （重登会作废旧 cookie）。
