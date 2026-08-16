# 영어지문 파헤치기

사진 또는 텍스트로 영어 문제 1개를 입력하면, 내장된 `guide/해설제작가이드.md` 규칙에 따라 GPT가 해설 내용을 구조화하고 A3 수능형 해설지 PDF를 생성하는 로컬 웹앱이다.

## 1. 준비

- Node.js 20 이상 권장
- OpenAI API Key

## 2. 설치

PowerShell에서 프로젝트 폴더로 이동한 뒤:

```powershell
npm install
Copy-Item .env.example .env
notepad .env
```

`.env`의 다음 부분을 실제 API 키로 교체한다.

```env
OPENAI_API_KEY=sk-your-api-key-here
OPENAI_MODEL=gpt-5.6
PORT=3000
```

## 3. 실행

```powershell
npm start
```

브라우저에서 다음 주소로 접속한다.

```text
http://localhost:3000
```

## 4. 동작 구조

### 최초 해설 생성

`POST /api/generate-explanation`

1. 사진 또는 텍스트 1문제 수신
2. 서버 내부의 `guide/해설제작가이드.md` 로드
3. OpenAI Responses API로 문제 분석 + 구조화된 해설 JSON 생성
4. JSON을 A3 세로 / 좌우 2단 / 흑백 시험지형 HTML로 렌더링
5. Puppeteer로 PDF 생성
6. `[지문주제]_해설.pdf` 반환
7. 수정용 기준 JSON을 `data/<문서ID>.json`에 저장

### 부분 수정

`POST /api/revise-explanation`

1. 기존 문서 JSON을 기준본으로 로드
2. GPT는 전체 문서를 다시 쓰지 않고 수정할 leaf 필드 경로와 교체값만 반환
3. 서버가 허용된 경로인지 검사
4. 해당 필드만 patch
5. diff 검사로 다른 필드 변경 여부 확인
6. 검증된 경우에만 PDF 재렌더링

## 5. 중요

- API Key는 `public/index.html`에 넣지 않는다.
- `.env` 파일은 외부에 공유하지 않는다.
- 현재 진행률은 실제 토큰 단위 진행률이 아니라 작업 대기 중 표시되는 단계형 추정치이다.
- 로컬 단일 사용자 프로토타입 기준으로 문서 JSON을 `data` 폴더에 저장한다.
