# わんコメ YouTube 配信自動セット プラグイン 設計書（ドラフト）

作成: 2026-10-26

## 1. 目的

YouTube で配信を始めたら、わんコメの YouTube 枠の URL を「今配信中の枠」（`https://www.youtube.com/watch?v=<動画ID>`）に自動で書き換え、配信のたびに URL を貼り替える手間をなくす。

他の配信者にも配布する前提で作る。

## 2. 背景（2026-10-26 に実測）

| 試したこと | 結果 |
|---|---|
| わんコメに `https://www.youtube.com/@<ハンドル>/live` | 予約枠が公開だと、YouTube が予約枠のほうを返す（配信中の枠ではない） |
| 予約枠を限定公開にして `/live` | YouTube は配信中の枠を返すが、わんコメはチャット欄の読み込みに失敗する（ログに `Failed to load URL: https://www.youtube.com/live_chat?continuation=...`） |
| わんコメに `https://www.youtube.com/watch?v=<動画ID>` | コメントが正常に取れる |
| わんコメに `https://www.youtube.com/@<ハンドル>` | チャンネルトップ扱いでコメントは取れない |

→ 「配信中の動画 ID を見つけて `watch?v=` 形式で入れる」ことが必要。

## 3. 全体の流れ

```
[YouTube Data API v3（公式）] <--HTTPS-- [プラグイン（わんコメ内の Node）] --HTTP--> [わんコメ HTTP API localhost:11180]
                                                  ^
                                   [設定画面 localhost:11180/plugins/<uid>/index.html]
```

1. 一定間隔（既定 60 秒）で、自分のチャンネルの「配信中」の動画を探す
2. 見つかった動画 ID が、対象の枠の今の URL と違えば、`PUT /api/services/{id}` で URL を書き換える
3. 枠が接続中なら、つなぎ直す（OFF → ON）※ 必要かどうかは実測で確認する（§8）

## 4. 配信中の枠の探し方

規約上の理由で YouTube Data API v3（公式）を使う。わんコメ利用規約の禁止事項 17「非公開もしくは許諾のないAPIを用いて連携を行うこと」に当たらないようにするため。`/live` や配信一覧ページの HTML 解析はしない。

| 手順 | API | 利用枠（quota） | 頻度 |
|---|---|---|---|
| ハンドル → チャンネル ID・アップロード再生リスト ID | `channels.list?part=id,contentDetails&forHandle=@xxx` | 1 | 設定変更時に 1 回（結果を保存） |
| 最近の動画 ID | `playlistItems.list?part=contentDetails&playlistId=UU...&maxResults=50` | 1 | 毎回 |
| 配信中かどうか | `videos.list?part=snippet,liveStreamingDetails&id=...` | 1 | 毎回 |

- 判定: `liveStreamingDetails.actualStartTime` があり、`actualEndTime` がない動画を「配信中」とする。複数あれば `actualStartTime` が新しいもの
  - `snippet.liveBroadcastContent` は使わない。2026-10-26 の実測で、配信開始後（`actualStartTime` あり）も `"upcoming"` のまま返ってきたため（反映が遅れる）
- 60 秒ごとで 1 日 2,880 units（無料枠 10,000 units/日 の範囲内）
- `search.list`（1 回 100 units）は使わない
- 2026-10-26 確認: 公開の予約枠はアップロード再生リストに入る。配信を始めても同じ動画 ID のまま
- 再生リストは枠を作った順に並ぶため、前もって作った予約枠が埋もれないよう 50 件見る（quota は 1 unit のまま。`videos.list` も 50 件まで 1 回で取れる）
- 限定公開の動画は API キーでは見えない → 対象は公開配信のみ（README に書く）

API キーは利用者が各自で発行する（配布物にキーを入れない）。

## 5. 設定項目（プラグインの store に保存）

| キー | 型 | 既定 | 内容 |
|---|---|---|---|
| `apiKey` | string | "" | YouTube Data API キー。設定画面の GET では返さない（「設定済み」かどうかだけ返す） |
| `channel` | string | "" | `@ハンドル` またはチャンネル URL |
| `serviceId` | string | "" | 書き換える わんコメ の枠の ID（設定画面で一覧から選ぶ） |
| `intervalSec` | number | 60 | 確認間隔。下限 60 |
| `enabled` | boolean | true | 自動セットを使うか |
| `authMode` | `"apiKey"` \| `"oauth"` | `"apiKey"` | 配信の探し方（§9） |
| `oauthClientId` | string | "" | OAuth クライアント ID（`*.apps.googleusercontent.com`） |
| `oauthClientSecret` | string | "" | OAuth クライアントシークレット。GET では返さない |
| `refreshToken` | string | "" | ログインで得たトークン。設定画面からは書けない・GET では返さない |

内部状態（保存）: 解決済みの `channelId` / `uploadsPlaylistId`、最後にセットした動画 ID、最後のエラー。

## 6. プラグインの構成（わんコメ 5.2+ / Node 20+）

- 配置: `%APPDATA%\onecomme\plugins\<フォルダ>\plugin.js` + 設定画面の静的ファイル
- `plugin.js` は CommonJS（`module.exports = plugin`）
- `init({ dir, store })` でタイマー開始、`destroy()` で停止
- 設定画面: `http://localhost:11180/plugins/<uid>/index.html`。`/api/plugins/<uid>` を `request()` で処理（GET: 設定と状態 / PUT: 設定保存 / POST: 今すぐ確認）
- 設定画面は外部 CDN を使わない（素の HTML/JS）
- `permissions`: 受け取るイベントは不要なので最小限（必須項目のため空配列で動くか確認）

コードの層:

- `domain/`: 純粋関数（チャンネル入力の解析、API レスポンスから配信中の動画を選ぶ、書き換えが必要かの判定）→ フィクスチャで TDD
- `infra/`: YouTube API クライアント、わんコメ API クライアント（`fetch` を注入してテストで差し替え）
- `app/`: 定期実行ループ（多重実行防止、失敗時の待ち時間の延長）
- `plugin.ts`: わんコメとの接続のみ

## 7. エラーと安全

- わんコメを落とさない: タイマーと `request()` は必ず try/catch
- 外部レスポンスは型ガードで検証してから使う
- API キーはログ・設定画面の GET・エラーメッセージに出さない
- 失敗が続いたら間隔を延ばす（最大 10 分）。quota 超過（403 `quotaExceeded`）なら翌日まで止める
- わんコメ API は `127.0.0.1:11180` 固定。外部へは `www.googleapis.com` にしか通信しない
- 対象の枠が消えていたら何もせず、状態欄にエラーを出す

## 8. 実測で確かめること

- [x] `PUT /api/services/{id}` に `{ "url": ... }` だけ送ると URL だけ変わる（2026-10-26 確認。`POST` で作る時は `id` 必須）
- [ ] 接続中の枠の URL を変えたとき、わんコメが自動でつなぎ直すか（しないなら `enabled` を false → true）
- [x] 予約枠・配信中の枠がアップロード再生リストに入るか（入る。2026-10-26 確認）
- [x] 配信開始から API に出るまでの遅れ（2026-10-26: `actualStartTime` は開始直後に出た。`liveBroadcastContent` が `live` になるまでは 1〜2 分）
- [ ] `permissions: []` で読み込めるか

## 9. Google ログイン方式（OAuth）【決定 2026-10-27】

API キー方式では公開の動画しか見えず、限定公開・非公開・メン限の配信を見つけられない（2026-10-27 に限定公開で確認）。そのため、利用者本人の許可で「自分の配信」を読む方式を追加する。API キー方式も残し、設定画面で選ぶ。

| | API キー方式 | Google ログイン方式 |
|---|---|---|
| 見つけられる配信 | 公開のみ | 自分の配信すべて（限定公開・非公開・メン限を含む） |
| 1 回の確認の quota | 2 | 1 |
| 準備 | API キー | OAuth クライアント（デスクトップアプリ）の ID とシークレット + ログイン |

### 9.1 配信中の枠の探し方

- `liveBroadcasts.list?part=id,snippet,status&broadcastStatus=active&broadcastType=all&maxResults=50`
  - `broadcastStatus` と `mine` は併用不可（どちらか 1 つ）。`active` は認証ユーザーの配信中の枠
  - `broadcastType` の既定は `event`（予約した配信のみ）。「今すぐ配信」も拾うため `all`
- 判定: `snippet.actualStartTime` があり `actualEndTime` がない枠。複数あれば開始が新しいもの。配信の ID はそのまま動画 ID
- scope: `https://www.googleapis.com/auth/youtube.readonly`（読み取り専用）

### 9.2 ログインの流れ（PKCE + ループバック）

1. 設定画面で「Google でログイン」→ プラグインに `POST {action:"oauthStart"}`
2. プラグインが `127.0.0.1` の空いているポートで一時サーバーを立て、`state` と PKCE（S256）を作って認可 URL を返す
3. 設定画面が認可 URL を開く → 利用者が Google の画面で許可
4. Google が `http://127.0.0.1:<port>/?code=...&state=...` に戻す → `state` を照合し、コードをトークンに交換（`access_type=offline`・`prompt=consent` でリフレッシュトークンを得る）
5. 一時サーバーは 1 回受け取るか 5 分で閉じる。返すページは固定の文言のみ（受け取った値を画面に出さない）

### 9.3 保存と安全

- 保存: `oauthClientId` / `oauthClientSecret` / `refreshToken`。シークレットとリフレッシュトークンは設定画面の GET に返さない（「設定済み」「ログイン済み」だけ返す）・ログに出さない
- アクセストークンはメモリのみ（期限の 60 秒前に更新）
- リフレッシュトークンが無効（`invalid_grant`）になったら「再ログインが必要」と表示して止める
- 「ログアウト」でリフレッシュトークンを消し、Google の revoke エンドポイントで無効化も試みる
- 保存先は わんコメ のプラグイン設定ファイル（平文）。README に「PC を共有する場合は注意」と書く
- OAuth クライアントは利用者が各自作る。配布側で共通のものを用意すると Google の審査が要り、未審査だと警告画面が出るため

### 9.4 利用者への注意（README）

- OAuth 同意画面の公開ステータスが「テスト中」だとリフレッシュトークンが 7 日で失効する → 「本番環境」にしてから（切り替え後に）ログインする。本番にしても審査は不要（自分だけが使う場合、「確認されていないアプリ」の警告を進めればよい）
- 6 か月使わないとトークンは失効する

### 9.5 確認状況

- [x] Google ログイン方式で限定公開の配信中の枠を見つけ、わんコメの枠 URL を書き換えられた（2026-10-27 実機）
- [ ] わんコメが限定公開の配信のチャットを `watch?v=` で読めるか
- [ ] メン限の配信（わんコメ 側のログインが要る可能性）

## 10. 配布に向けて（後で）

- ライセンスを決める
- README: API キーの発行手順、免責（わんコメ・YouTube とは無関係の非公式ツール）
- YouTube API サービス利用規約・Google のプライバシーポリシーへの同意・リンク表記の要否を確認
- わんコメ公式と誤解されない名前（わんコメのロゴは使わない）
- 依存パッケージ候補（未導入・要相談）: typescript / esbuild / vitest（いずれも開発用で配布物に入らない）。`@onecomme.com/onesdk` はライセンスが独自（OneComme-Use-Only）なので使わず、必要な型は自分で書く
