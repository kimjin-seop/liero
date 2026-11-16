# 리에로 포에버 — 서버 배포 가이드

배포 주소: **https://liero.oddplay.kr/**

## 구성

```
liero-forever/
├── server.js                  게임 서버 (웹페이지 제공 + 실시간 대전)
├── public/index.html          게임 화면 (클라이언트 전체가 이 파일 하나)
├── package.json / package-lock.json
├── Dockerfile                 도커로 배포할 때
└── deploy/
    ├── nginx-liero.oddplay.kr.conf   nginx 설정 (HTTPS + WebSocket)
    └── ecosystem.config.js           pm2 설정
```

- 서버가 게임 계산을 직접 합니다. 방장 탭이 내려가도 게임이 멈추지 않고, 조작 치트도 막힙니다.
- 게임 규칙 코드는 `public/index.html` 안의 `//CORE-START ~ //CORE-END` 부분 하나뿐입니다. 서버가 시작할 때 이 부분을 읽어서 씁니다. 그래서 **무기 수치나 물리를 바꿀 때 index.html만 고치고 서버를 재시작**하면 클라이언트와 서버에 함께 반영됩니다.
- 같은 index.html을 claude.ai 아티팩트에 올려도 동작합니다. 서버에서 열면 서버 모드, claude.ai에서 열면 기존 공유 방식으로 자동 전환됩니다.
- 필요한 것: Node.js 18 이상 (20 권장). 외부 패키지는 `ws` 하나뿐입니다.

## 1. 내 PC에서 먼저 실행해 보기

```bash
cd liero-forever
npm install
npm start
```

브라우저에서 http://localhost:3000 을 엽니다. 창을 두 개 띄워 온라인 대전 → 방 만들기 → 다른 창에서 입장 → 둘 다 준비를 누르면 게임이 시작됩니다.

## 2. 리눅스 서버(VPS)에 배포 — 추천

Ubuntu 22.04/24.04 기준입니다. 한국 사용자가 대상이면 **서울 리전** 서버를 쓰세요. 실시간 게임이라 핑이 체감에 바로 영향을 줍니다. 예: AWS Lightsail 서울, 오라클 클라우드 춘천/서울(무료 티어), 네이버 클라우드, Vultr 서울.

### 2-1. DNS 연결

도메인 관리 화면(oddplay.kr)에서 레코드를 하나 추가합니다.

| 타입 | 이름 | 값 |
|---|---|---|
| A | `liero` | 서버 공인 IP |

`ping liero.oddplay.kr` 로 서버 IP가 나오면 연결된 것입니다. 반영까지 몇 분에서 몇 시간 걸릴 수 있어요.

### 2-2. 서버 준비

```bash
# Node.js 20 설치
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx

# pm2 (프로세스 관리: 꺼지면 자동 재시작, 재부팅 시 자동 실행)
sudo npm install -g pm2

# 방화벽 (ufw를 쓰는 경우)
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

> 클라우드 콘솔의 보안 그룹(방화벽)에서도 **80, 443 포트**를 열어야 합니다. 3000번은 열지 마세요. nginx만 외부에 노출합니다.

### 2-3. 게임 서버 올리기

```bash
# 내 PC에서 서버로 파일 복사 (예시)
scp -r liero-forever ubuntu@서버IP:~/

# 서버에서
cd ~/liero-forever
npm ci --omit=dev
pm2 start deploy/ecosystem.config.js
pm2 save
pm2 startup        # 출력되는 sudo 명령을 한 번 복사해서 실행
```

`curl http://127.0.0.1:3000/healthz` 에서 `{"ok":true,...}` 가 나오면 정상입니다.

### 2-4. nginx + HTTPS

```bash
sudo cp deploy/nginx-liero.oddplay.kr.conf /etc/nginx/sites-available/liero.oddplay.kr
sudo ln -s /etc/nginx/sites-available/liero.oddplay.kr /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 무료 HTTPS 인증서 (Let's Encrypt)
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d liero.oddplay.kr
```

이제 https://liero.oddplay.kr/ 로 접속됩니다. 인증서는 certbot이 자동으로 갱신합니다.

> nginx 설정의 `/ws` 부분이 WebSocket 연결을 넘겨주는 핵심입니다. 이게 빠지면 페이지는 뜨는데 "게임 서버에 연결할 수 없어요"가 나옵니다.

### 2-5. 업데이트할 때

```bash
cd ~/liero-forever
# 바뀐 public/index.html 또는 server.js 를 덮어쓴 뒤
pm2 restart liero-forever
```

재시작하면 진행 중인 방은 초기화됩니다. 사람이 적은 시간에 하세요.

### 자주 쓰는 명령

```bash
pm2 logs liero-forever     # 로그 보기 (게임 시작/방 닫힘 기록)
pm2 status                 # 상태 확인
pm2 restart liero-forever  # 재시작
```

## 3. 도커로 배포 (선택)

```bash
docker build -t liero-forever .
docker run -d --name liero --restart unless-stopped -p 127.0.0.1:3000:3000 liero-forever
```

nginx와 HTTPS는 2-4와 똑같이 설정합니다.

## 4. 클라우드 플랫폼 (Render / Railway / Fly.io)

서버 관리가 귀찮다면 이쪽도 됩니다. WebSocket을 지원하는 곳이어야 합니다.

- **Render:** New → Web Service → 이 폴더를 올린 GitHub 저장소 선택 → Build `npm ci`, Start `npm start` → Settings → Custom Domain에 `liero.oddplay.kr` 추가 후 안내된 CNAME을 DNS에 등록. 무료 플랜은 15분간 접속이 없으면 잠들어 첫 접속이 30초쯤 느립니다.
- **Railway / Fly.io:** Dockerfile을 자동 인식합니다. 커스텀 도메인을 연결하고 DNS에 CNAME을 추가하세요. Fly.io는 도쿄(nrt) 리전이 한국과 가깝습니다.

> 인스턴스는 **반드시 1개**로 두세요. 방 정보를 서버 메모리에 두기 때문에, 여러 대로 나누면 서로 다른 방 목록이 보입니다.

## 5. 설정값 (환경 변수)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | 3000 | 서버 포트 |
| `HOST` | 0.0.0.0 | 바인딩 주소 (nginx 뒤라면 127.0.0.1 권장) |
| `MAX_CLIENTS` | 300 | 동시 접속 최대 인원 |
| `MAX_ROOMS` | 60 | 최대 방 개수 |

## 6. 성능 참고

- 방 하나는 60틱으로 돌아가고, 플레이어마다 초당 30번 상태를 받습니다. 6명 방 기준 사용자당 대략 초당 30~70KB입니다.
- 1코어 1GB 서버로 동시에 방 10~20개 정도는 여유 있게 돌아갑니다.
- 트래픽이 많아지면 nginx에서 gzip 대신 WebSocket 압축(permessage-deflate)을 켜는 것보다, 먼저 서울 리전의 더 좋은 CPU로 옮기는 게 효과가 큽니다.

## 7. 문제 해결

| 증상 | 확인할 것 |
|---|---|
| 페이지가 안 열림 | DNS A 레코드, 클라우드 방화벽 80/443, `sudo nginx -t` |
| 페이지는 열리는데 "게임 서버에 연결할 수 없어요" | nginx `/ws` 설정, `pm2 status`로 서버 실행 여부 |
| 게임 중 자꾸 끊김 | nginx `proxy_read_timeout`, 클라우드 로드밸런서의 유휴 타임아웃(60초 이상) |
| 수정한 게 반영 안 됨 | `pm2 restart liero-forever` 후 브라우저 강력 새로고침 |
