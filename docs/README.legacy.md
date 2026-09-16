# 璞嗗寘鏈湴涓浆锛坉oubao-relay锛?
鎶婅眴鍖呯綉椤电増鍙樻垚 **鏈満 OpenAI 鍏煎 API**锛氬璐﹀彿杞崲銆丼eedream 鏂囩敓鍥俱€丼eedance 鏂囩敓瑙嗛锛屼互鍙婂鍙傝€冨浘瑙掕壊涓€鑷存€с€傛棤闇€ Docker锛屼粎闄愪釜浜鸿嚜鐢ㄣ€?
![绠＄悊椤碉細瀹炴椂鏃ュ織涓庡弬鑰冨浘鏍稿](docs/dashboard.png)

## 瀹冭В鍐充粈涔堥棶棰?
瀹樻柟鐏北鏂硅垷瑕?Key銆佽璁¤垂锛涚綉椤电増鍙堜笉濂芥帴宸ヤ綔娴併€傛湰椤圭洰鍦ㄦ湰鏈哄紑涓€涓綉鍏筹紙榛樿 `:8787`锛夛紝鐢ㄤ綘鑷繁鐨勮眴鍖呯櫥褰曟€佸幓璋冪綉椤佃兘鍔涳紝鍐嶆妸缁撴灉浠ユ爣鍑?HTTP 鎺ュ彛浜ょ粰 Toonflow銆佽剼鏈垨鍏跺畠瀹㈡埛绔€?
```text
瀹㈡埛绔?/ Toonflow
        鈹? Bearer LOCAL_API_KEY
        鈻?  :8787  璞嗗寘鏈湴涓浆
        鈹? 娉ㄥ叆 session / Cookie锛岄檺娴佽嚜鍔ㄦ崲鍙?        鈹溾攢 鏂囩敓鍥?/ 瑙嗛锛氭湰鏈烘祻瑙堝櫒鎴?CDP 鐩磋繛璞嗗寘缃戦〉
        鈹斺攢 瀵硅瘽锛?8000 doubao-free-api锛堟湰鏈?Node锛?```

## 鍔熻兘涓€瑙?
| 鑳藉姏 | 璇存槑 |
|------|------|
| **澶氳处鍙锋睜** | 鐧诲綍澶氫釜璞嗗寘鍙凤紝闄愭祦鑷姩璺宠繃鍐峰嵈骞惰疆鎹?|
| **OpenAI 鍏煎 API** | `/v1/images/generations`銆乣/v1/videos/generations`銆乣/v1/chat/completions` |
| **Seedream 鏂囩敓鍥?* | 5.0 Lite / 5.0 / 4.5 / 4.0锛涙瘮渚?1:1銆?6:9銆?:16銆?:3銆?:4 |
| **瑙掕壊涓€鑷存€?* | 鍙傝€冨浘鏄犲皠涓?`@鍥綨`锛岃嚜鍔ㄦ敞鍏ヤ簲瀹?鏈嶉グ閿佸畾涓庨槻涓茶劯瑙勫垯 |
| **Seedance 鏂囩敓瑙嗛** | 2.5 / 2.0 / Fast / Mini锛涘悓姝ョ瓑寰咃紝鏈€闀跨害鏁板垎閽?|
| **绠＄悊椤?* | 鐧诲綍銆佹崲鍙枫€佸喎鍗淬€丼SE 瀹炴椂鏃ュ織銆佹湰鏈鸿瘯鐢熸垚 |
| **CDP 鎶楅鎺?* | 杩炴帴鏈満 Chrome/Edge 璋冭瘯绔彛锛岄檷浣?shark / 710022004 |

## 蹇€熷紑濮?
闇€瑕?Node.js 18+銆俉indows 绀轰緥锛?
```bash
cd doubao
copy .env.example .env
npm run setup
npm start
```

娴忚鍣ㄦ墦寮€ http://127.0.0.1:8787 鈫?鐐?**銆岀櫥褰曡眴鍖呫€?* 瀹屾垚鎵爜銆傝嫢鎶?`shark` / `710022004`锛屾敼鐢ㄦ湰鏈?Chrome/Edge 璋冭瘯鐧诲綍锛堣涓嬫枃锛夈€?
- 绠＄悊椤碉細http://127.0.0.1:8787
- 涓婃父 free-api锛歨ttp://127.0.0.1:8000锛坄npm start` 浼氫竴骞舵媺璧凤級

鍗曠嫭寮圭獥鐧诲綍锛?
```bash
npm run login
```

## 绠＄悊椤?
![璐﹀彿姹狅細鍒囨崲銆佹竻鍐峰嵈銆佸垹闄(docs/accounts.png)

- **鐧诲綍璞嗗寘 / 鎹㈣处鍙风櫥褰?*锛氬脊绐楁壂鐮侊紝浼氳瘽鍐欏叆 `data/session.json`
- **璐﹀彿姹?*锛氬垏鎹㈠綋鍓嶅彿銆佹竻闄ゅ喎鍗淬€佸垹闄ゅ崟涓处鍙?- **瀹炴椂鏃ュ織**锛歋SE 鎺ㄩ€侊紝涓婁紶鍙傝€冨浘鏃舵樉绀虹缉鐣ュ浘锛屼究浜庢牳瀵?`@鍥綨`
- **璇曚竴涓嬫枃鐢熷浘**锛氶€夋ā鍨嬩笌姣斾緥锛岀洿鎺ュ湪椤甸潰鍑哄浘

![鏈満璇曠敓鎴愪笌 curl 绀轰緥](docs/generate.png)

## 璋冪敤 API

閴存潈涓€寰嬩娇鐢?`.env` 閲岀殑 `LOCAL_API_KEY`锛堜笉瑕佹嬁璞嗗寘 `sessionid` 褰?Bearer锛夈€?
### 鏂囩敓鍥?
```bash
curl http://127.0.0.1:8787/v1/images/generations ^
  -H "Authorization: Bearer local-dev-key-change-me" ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"Seedream 4.5\",\"prompt\":\"涓€鍙埓澧ㄩ暅鐨勬鐚紝璧涘崥鏈嬪厠闇撹櫣锛岀數褰辨劅\",\"ratio\":\"1:1\"}"
```

澶氬弬鑰冨浘鏃讹紝鎶婂浘鐗囨斁杩?`images`锛坆ase64 鎴?URL锛夛紝鎻愮ず璇嶇敤 `@鍥?`銆乣@鍥?` 瀵瑰簲闄勪欢椤哄簭銆傜綉鍏充細鎶婂崰浣嶇粺涓€鎴愯眴鍖呯殑 `@鍥剧墖N`锛屽苟娉ㄥ叆瑙掕壊閿佸畾瑙勫垯銆?
```json
{
  "model": "Seedream 4.5",
  "prompt": "@鍥? 涓烘睙褰昏鑹诧紝@鍥? 涓哄姙鍏锛屾睙褰诲潗鍦ㄥ伐浣嶄笂鐪嬩俊灏?,
  "ratio": "16:9",
  "images": ["data:image/png;base64,...", "data:image/png;base64,..."]
}
```

### 鏂囩敓瑙嗛

```bash
curl http://127.0.0.1:8787/v1/videos/generations ^
  -H "Authorization: Bearer local-dev-key-change-me" ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"Seedance 2.0\",\"prompt\":\"涓€鍙鐚埓澧ㄩ暅璧拌繃闇撹櫣琛楅亾\",\"duration\":5,\"ratio\":\"16:9\"}"
```

鎺ュ彛浼氬悓姝ョ瓑寰呯粨鏋滐紝瓒呮椂绾︽暟鍒嗛挓銆備篃鍙敤 `/v1/videos`銆乣/v1/video/generations`銆?
### 瀵硅瘽

```bash
curl http://127.0.0.1:8787/v1/chat/completions ^
  -H "Authorization: Bearer local-dev-key-change-me" ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"doubao\",\"messages\":[{\"role\":\"user\",\"content\":\"浣犲ソ\"}]}"
```

## 鏈満娴忚鍣ㄨ皟璇曪紙鎶楅鎺э級

璞嗗寘浼氭牎楠屾祻瑙堝櫒鎸囩汗锛屽彧璐?Cookie 寰堝鏄撹鎷︺€傛帹鑽愮敤鏈満 Chrome 鎴?Edge 寮€杩滅▼璋冭瘯锛屽湪寮瑰嚭绐楀彛閲岀櫥褰曘€?
`.env`锛?
```env
DOUBAO_USE_CDP=1
DOUBAO_CDP_URL=http://127.0.0.1:9222
```

PowerShell 鍚姩 Edge锛堟帹鑽愶級锛?
```powershell
$dir = "$env:TEMP\doubao-cdp"; New-Item -ItemType Directory -Force -Path $dir | Out-Null
& "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --user-data-dir=$dir "https://www.doubao.com/chat/"
```

Chrome锛?
```powershell
$dir = "$env:TEMP\doubao-cdp"; New-Item -ItemType Directory -Force -Path $dir | Out-Null
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=$dir "https://www.doubao.com/chat/"
```

鏀瑰畬 `.env` 鍚庨噸鍚?`npm start`銆傜櫥褰曡鍦?*寮瑰嚭鐨勬祻瑙堝櫒绐楀彛**鎿嶄綔锛屼笉瑕佺敤骞虫椂鏃ュ父璧勬枡鐩綍銆?
## Toonflow 鎺ュ叆

瀵煎叆 [`toonflow/doubaorelay.ts`](toonflow/doubaorelay.ts)锛?
1. `npm start` 骞跺湪绠＄悊椤电櫥褰曡眴鍖?2. Toonflow 鈫?瀵煎叆渚涘簲鍟?鈫?閫夋嫨璇ユ枃浠?3. API 瀵嗛挜濉?`.env` 鐨?`LOCAL_API_KEY`
4. 璇锋眰鍦板潃濉?`http://127.0.0.1:8787/v1`

鏀寔瀵硅瘽銆丼eedream 澶氬弬鑰冨浘銆丼eedance 瑙嗛銆傞檺娴佹椂鍦ㄧ鐞嗛〉鐐?**銆屾崲璐﹀彿鐧诲綍銆?* 鍔犲彿锛涚敓鍥句細鑷姩璺宠繃鍐峰嵈璐﹀彿銆?
## 甯哥敤鍛戒护

| 鍛戒护 | 浣滅敤 |
|------|------|
| `npm start` | 鍚屾椂鍚姩涓婃父 + 缃戝叧 |
| `npm run gateway` | 鍙紑缃戝叧 |
| `npm run upstream` | 鍙紑 free-api |
| `npm run login` | 寮圭獥鐧诲綍鎶?session |
| `npm run login:switch` | 鎹㈣处鍙风櫥褰曪紙鍔犲叆璐﹀彿姹狅級 |
| `npm run setup` | 瀹夎渚濊禆骞舵瀯寤轰笂娓?|

## 鐜鍙橀噺

瑙?[`.env.example`](.env.example)銆傚父鐢ㄩ」锛?
| 鍙橀噺 | 榛樿 | 璇存槑 |
|------|------|------|
| `PORT` | `8787` | 缃戝叧绔彛 |
| `LOCAL_API_KEY` | `local-dev-key-change-me` | 瀹㈡埛绔?Bearer |
| `UPSTREAM_URL` | `http://127.0.0.1:8000` | 瀵硅瘽涓婃父 |
| `DOUBAO_USE_CDP` | 鈥?| 璁句负 `1` 璧版湰鏈烘祻瑙堝櫒璋冭瘯 |
| `DOUBAO_CDP_URL` | `http://127.0.0.1:9222` | CDP 鍦板潃 |
| `LOG_DIR` | `data/logs` | 鎸夊ぉ鍒囧垎鐨勬棩蹇?|
| `BROWSER_PROFILE_DIR` | `data/browser-profile` | Playwright 鐢ㄦ埛鏁版嵁 |

鍕挎彁浜?`data/`銆乣.env`銆乣vendor/**/node_modules`銆?
## 鍏嶈矗澹版槑

- 闈炲畼鏂规帴鍙ｏ紝缃戦〉鏀圭増鍗冲彲鑳藉け鏁堛€?- **浠呴檺涓汉鑷敤瀛︿範**锛岀姝㈠澶栨湇鍔℃垨鍟嗙敤銆?- 绋冲畾鐢熶骇璇风敤 [鐏北寮曟搸瀹樻柟 API](https://www.volcengine.com/product/doubao)銆?
