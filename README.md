# 오늘의 바리스타 ☕

직접 만든 음료를 들고, 카페 알바 동료들과 같은 매장에 앉아 공부하는 집중 타이머예요.
이 폴더를 그대로 웹에 올리면 누구나 주소로 들어와서 쓸 수 있어요.

## 파일 구성

| 파일 | 하는 일 |
|---|---|
| `index.html` | 카페 전체 (매장, 메뉴, 제조 게임, 타이머, 미니미, 진돌이) |
| `realtime.js` | 친구들과 같은 매장에 앉게 해주는 연결부 |
| `config.js` | 친구 연결 설정 (Supabase 주소와 키) |
| `manifest.webmanifest`, `icon-*.png`, `sw.js` | 폰 홈 화면에 앱처럼 설치되게 해주는 파일 |
| `server.js`, `package.json` | 카페 화면 + 친구 연결 서버 (Render Web Service 용) |
| `render.yaml` | Render 에 올릴 때 쓰는 설정 |

## 1. 내 컴퓨터에서 열어보기

폴더 안에서 아래를 실행하고, 브라우저로 `http://localhost:8000` 을 열어요. (Node 18 이상)

```bash
node server.js
```

`index.html` 을 더블클릭해도 열리지만, 앱 설치 기능은 위처럼 주소로 열어야 동작해요.

## 2. Render 로 올리기 (친구 연결 포함)

이 폴더에는 작은 서버(`server.js`)가 들어 있어요. 카페 화면을 보여주면서, 같은 매장에 들어온 친구들을 실시간으로 이어줘요.
설치할 패키지가 없어서 따로 가입할 서비스도 없어요.

1. https://dashboard.render.com 에서 **New → Web Service** 를 눌러요. (Static Site 가 아니에요!)
2. **moncafe** 저장소를 골라요.
3. 아래처럼 적어요.
   - **Runtime / Language**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: Free
4. **Create Web Service** 를 누르면 `https://moncafe.onrender.com` 같은 주소가 생겨요.
5. 그 주소를 친구에게 보내면 같은 매장에 출근해요.

`render.yaml` 이 들어 있어서 **New → Blueprint** 로 저장소를 고르면 위 설정이 자동으로 채워져요. (화면 메뉴 이름은 조금씩 바뀔 수 있어요.)

> 무료 서버는 한동안 아무도 안 들어오면 잠들어요. 그다음 처음 들어오는 사람은 30초~1분쯤 기다려야 열려요.
> 예전에 만든 Static Site 는 친구 연결이 안 되니 지워도 돼요.

### 다른 곳에 올리기


가장 쉬운 방법은 **Netlify Drop** 이에요.

1. https://app.netlify.com/drop 에 접속해요.
2. 이 폴더를 통째로 끌어다 놓아요.
3. 생긴 주소(예: `https://xxxx.netlify.app`)로 바로 접속돼요.

다른 방법: Vercel, GitHub Pages, Cloudflare Pages 도 모두 무료로 이 폴더를 그대로 올릴 수 있어요.

## 3. (선택) Supabase 로 친구 연결하기

Render Web Service 로 올렸다면 이 단계는 필요 없어요. 서버 없이 정적 사이트로만 올릴 때 쓰는 방법이에요.

`config.js` 를 비워두면 **같은 브라우저의 탭끼리만** 서로 보여요(테스트용).
인터넷으로 친구들과 같은 매장에 앉으려면 무료 서비스 **Supabase** 를 연결해요. 테이블을 만들 필요는 없어요.

1. https://supabase.com 에 가입하고 **New project** 를 만들어요.
2. 프로젝트 설정의 API(또는 Connect) 화면에서 두 가지를 복사해요. (메뉴 이름은 조금씩 바뀔 수 있어요.)
   - **Project URL** (예: `https://abcdefgh.supabase.co`)
   - **anon / publishable key** (공개용 키)
3. `config.js` 에 붙여 넣어요.

```js
window.CAFE_CONFIG = {
  supabaseUrl: 'https://abcdefgh.supabase.co',
  supabaseAnonKey: 'eyJhbGciOi...',
  room: 'main',
};
```

4. 다시 웹에 올리고, 주소를 친구에게 보내면 같은 매장에 출근해요.

> ⚠️ `service_role` 키(비밀 키)는 절대 넣지 마세요. 웹페이지에 넣는 건 공개용 키만이에요.

### 매장 나누기

주소 뒤에 `?room=이름` 을 붙이면 그 이름끼리만 만나요.

```
https://xxxx.netlify.app/?room=우리반
https://xxxx.netlify.app/?room=스터디3조
```

## 4. 폰에 앱처럼 설치하기

- **안드로이드 (크롬)**: 메뉴 ⋮ → "앱 설치" 또는 "홈 화면에 추가"
- **아이폰 (사파리)**: 공유 버튼 → "홈 화면에 추가"

진돌이 아이콘으로 홈 화면에 생겨요.

## 5. 고치고 다시 올릴 때

- `sw.js` 맨 위의 `VERSION` 숫자를 올려주세요 (예: `cafe-v1` → `cafe-v2`). 그래야 폰에 설치된 앱도 새 버전을 받아요.
- 공부 중이던 타이머는 브라우저에 저장돼서, 새 버전이 올라가도 이어서 진행돼요.

## 6. 나중에 앱스토어에 올리고 싶다면

웹 코드를 그대로 앱으로 감싸는 **Capacitor** 를 쓰면 새로 만들 필요가 없어요.

```bash
npm init -y
npm i @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android
npx cap init "오늘의 바리스타" com.example.barista --web-dir .
npx cap add android   # 또는 ios
npx cap open android
```

애플 개발자 계정(연간 유료)과 구글 플레이 개발자 계정(1회 유료)이 필요해요.

## 알아둘 것

- **기록은 각자 브라우저에 저장돼요.** 근무 일지, 팁, 캐릭터, 자리, 진행 중인 타이머는 `localStorage` 에 있어서, 브라우저를 바꾸거나 기록을 지우면 사라져요.
- **매장에 보이는 정보**: 같은 room 에 들어온 사람에게는 이름표, 캐릭터, 마시는 음료, 공부 상태, 말풍선이 보여요. 주소와 room 이름을 아는 사람은 누구나 들어올 수 있어요.
- **손님 NPC 와 진돌이**는 각자 화면에서만 움직여요.
- **진돌이 광고 사진**은 `index.html` 안에 들어 있어요. 공개로 올리면 누구나 볼 수 있어요.
- 글꼴은 Google Fonts(Jua, Gowun Dodum, IBM Plex Mono)를 불러와요. 인터넷이 없으면 기본 글꼴로 보여요.
