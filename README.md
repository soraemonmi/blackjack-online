# BLACKJACK ONLINE

スマホ・PCブラウザ向けのリアルタイムオンラインブラックジャックです。

## 主な仕様
- 名前入力 / ルームコード
- 最大20接続（プレイヤー＋観戦者）
- プレイヤー / 観戦者
- 通常対戦 / 連戦 / トーナメント基礎モード
- CPUディーラー / プレイヤーディーラー
- HIT / STAND / DOUBLE DOWN
- 選択→OK→全員OKで一斉公開→ディーラーターン
- プレイヤーは自分以外の手札を一斉公開前は見られない
- ディーラーも一斉公開前はプレイヤーの手札を見られない
- 観戦者はリアルタイムで全員の手札を見られる
- ベット額とDOUBLE DOWN後の2倍ベット額は公開
- 初期コイン / 最低BET / 最高BETをホストが設定
- BGM ON/OFF
- HIT / STAND / DOUBLE DOWNの日本語音声読み上げ
- チャット / 退出 / RESTART
- カード配布 / 一斉公開 / ディーラーターン / 結果演出
- PWA対応

## コイン
デフォルトは初期10,000コイン、最低BET 100、最高BET 5,000。
ベット時にコインを差し引き、DOUBLE DOWNでは追加分を差し引きます。
通常勝利は2倍払い戻し、BJは2.5倍払い戻し、プッシュはBET返還です。
ゲーム内コインのみで、現金・換金には対応していません。

## ローカル起動

```bash
npm install
npm start
```

ブラウザで `http://localhost:3000` を開きます。

## GitHub / Render
GitHubへpushしてからRenderのWeb Serviceに接続します。

Build Command:
`npm install`

Start Command:
`npm start`

Health Check Path:
`/health`

## 注意
この配布版はインメモリルーム構成です。サーバー再起動時にルーム状態は消えます。
本番運用では再接続・永続化・レート制限・認証などを追加してください。

## ルームID表示
ゲーム画面に入ると、ルームIDが上部のROOM ID欄に常時表示されます。ホスト画面では設定欄と同じ画面で確認でき、「コピー」でルームIDをコピーできます。

## ディーラー設定
ホストがロビーでディーラーをCPUまたは参加中のプレイヤーから選択できます。クライアントは `dealerId` を送信し、サーバー側で検証します。


### Latest fixes
- Removed repeated full-screen re-rendering of the card table during the decision countdown, which caused visible card flicker on mobile.
- Disabled card animation/transition explicitly.
- Replaced the previous beep-only BGM with a repeating Web Audio melody. Tap BGM ON to start it.

## 最新版の変更
- スマホの試合中はホスト設定・START・ROUND表示を自動で隠し、カード卓を優先表示します。
- 画面端にメニュー・リスタート・退出だけを残します。
- BET/HIT/STAND/DOUBLE DOWN操作欄は画面下部に固定し、カードが隠れにくいスマホUIにしています。
- カードは状態が変わったときだけDOMを更新し、再描画によるちらつきを防止しています。
- BGMはWeb Audioの簡易音ではなく、同梱の`public/bgm.wav`をループ再生します。BGMボタンはユーザー操作で開始します。
