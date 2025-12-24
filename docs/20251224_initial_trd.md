# TRD: `ccenv` (Claude Code Environment Manager)

## 1. 概要 (Overview)

`ccenv` は、単一のGitリポジトリ上で、物理的なディレクトリ移動（Worktree）を行わずに、論理的な作業環境（Environment）を仮想的に切り替えるCLIツールである。
Claude CodeのようなAIエージェントが、ユーザーの作業中のコードや他のタスクと競合することなく、非同期かつ安全にコードベースを操作することを可能にする。

### 1.1 解決する課題

* **Git Worktreeの重さ:** 新しいWorktree作成時の `npm install` や `go mod download` などの環境構築コスト、ディスク容量の圧迫。
* **環境の衝突:** 同一マシン上でのポート番号の競合、環境変数の管理コスト、LSPやエディタ設定の複雑化。
* **並行作業の安全性:** AIがバックグラウンドで作業する際、人間が編集中のファイルを上書きしたり、逆に人間がAIの作業途中のファイルを触ってしまうリスク。

---

## 2. システムアーキテクチャ (System Architecture)

### 2.1 コアコンセプト: "State Swapping" (状態スワップ)

本ツールは、リポジトリの「現在の物理的な状態」を一時退避させ、保存されていた「仮想環境の状態」を展開することで、瞬時にコンテキストを切り替える。

### 2.2 データ構造: Git Absolute Dump

リポジトリの状態を以下の4要素で定義し、シリアライズ可能な形式（tarball + patchファイル）で保存する。

1. **Base Commit:** 現在の `HEAD` のハッシュ。
2. **Staged Changes:** `git diff --cached --binary` の結果。
3. **Unstaged Changes:** `git diff --binary` の結果。
4. **Untracked Files:** 新規追加ファイル（`git ls-files --others --exclude-standard`）のアーカイブ。

### 2.3 ディレクトリ構造

```text
.ccenv/
├── config.json          # グローバル設定
├── lock                 # プロセス排他制御用ロックファイル
├── state                # 現在ディレクトリが「誰の」状態かを示すメタデータ
├── envs/                # 各環境のデータを保存
│   ├── default/         # ユーザーの元の状態（退避用）
│   │   ├── info.json    # ブランチ情報など
│   │   ├── staged.patch
│   │   ├── unstaged.patch
│   │   └── untracked.tar.gz
│   └── feature-a/       # 仮想環境A
│       └── ...

```

---

## 3. 機能要件 (Functional Requirements)

### 3.1 CLI コマンド仕様

#### `ccenv create <name>`

* **機能:** 新しい隔離環境用のディレクトリを `.ccenv/envs/<name>` に作成する。
* **初期状態:** 現在のGitのHEAD状態を継承するか、空の状態から開始するかオプションで指定可能（デフォルトはHEAD継承）。

#### `ccenv activate <name>`

* **機能:** シェルの環境変数 `CCENV_ACTIVE` を設定するためのコマンドを出力する（Pythonのvenv同様、`eval $(ccenv activate <name>)` のように利用）。
* **目的:** 以降の `run` コマンド等で環境名を省略可能にする。

#### `ccenv run <command...>`

* **機能:** `enter` → 指定コマンド実行 → `exit` をアトミックに行うラッパー。
* **フロー:**
1. `ccenv enter` を実行（ロック取得、状態スワップ）。
2. サブプロセスで `<command>` を実行。
3. コマンドの終了コードを保持。
4. `ccenv exit` を実行（状態保存、元に戻す、ロック解除）。
5. 保持した終了コードで終了。


* **補足:** `trap` 等を用いて、SIGINT等で中断された場合でも確実に `exit` が呼ばれるようにする。

#### `ccenv enter`

* **機能:** 仮想環境へ入り込む（状態のスワップ）。
* **処理フロー:**
1. **TryLock:** `.ccenv/lock` ファイルの作成を試みる。失敗した場合は待機またはエラー。
2. **Snapshot Host:** 現在のワークスペースの状態（人間が作業中の状態）を `envs/host_snapshot` (または `default`) にシリアライズして保存。
3. **Clean:** `git reset --hard` および `git clean -fd` を行い、クリーンな状態にする。
4. **Restore Env:** 指定された環境（例: `feature-a`）のダンプが存在すれば、それを適用（`git apply`, untrackedファイルの展開）。
5. **Update State:** `.ccenv/state` に「現在 `feature-a` が占有中」と記録。



#### `ccenv exit`

* **機能:** 仮想環境から抜け出し、元の状態に戻す。
* **処理フロー:**
1. **Check State:** 本当に仮想環境の中にいるか確認。
2. **Snapshot Env:** 現在のワークスペースの状態を、現在の環境ディレクトリ（例: `envs/feature-a`）に上書き保存。
3. **Clean:** ワークスペースをクリーンにする。
4. **Restore Host:** `envs/host_snapshot` から、ユーザーの元の作業状態を復元する。
5. **Unlock:** ロックファイルを削除する。



#### `ccenv apply`

* **機能:** 仮想環境での変更内容を、現在のユーザー環境（メインのコードベース）に適用する。GitのMergeやStash Popに近い。
* **挙動:**
* ロックは作成しない。
* 仮想環境のパッチとファイルを現在のワークスペースに適用する。
* 競合が発生した場合、Gitの標準的なコンフリクトマーカーを残して終了する。



---
## 4. 技術的実現方法の詳細 (Technical Implementation) - **Revised for Bun/TS**

### 4.1 ランタイム・言語

* **Runtime:** Bun (v1.1以上を推奨)
* **Language:** TypeScript
* **Rationale:** * **起動速度:** AIのhookとして頻繁に呼ばれるため、Node.jsより高速なBunを採用。
* **Bun Shell:** `await $`git diff ...`` のように、シェルコマンドをテンプレートリテラルで直感的に扱える。
* **シングルバイナリ化:** `bun build --compile` により、Goと同様に配布が容易な単一バイナリを作成可能。



### 4.2 コアモジュール

* **Git操作:** `Bun.$` を利用したシステムGitのラッパー。
* **ファイル操作:** `Bun.file()` および `node:fs` (再帰的なディレクトリ作成やシンボリックリンク操作用)。
* **ロック機構:** `node:fs` の `mkdir` によるアトミックなロック、または `Bun.file` を用いたPID記録式ロック。

### 4.3 シリアライズ/デシリアライズ実装（Bun版）

#### Dump (保存)

```typescript
import { $ } from "bun";

async function dump(targetDir: string) {
  // 1. Untracked files のリストアップとアーカイブ
  const untrackedFiles = await $`git ls-files --others --exclude-standard`.text();
  if (untrackedFiles.trim()) {
    // Bun.spawnでtarを実行し、標準入力を経由してファイルに保存
    await $`tar -czf ${targetDir}/untracked.tar.gz -T -`.stdin(untrackedFiles);
  }

  // 2. Staged/Unstaged Changes をパッチとして出力
  // --binaryフラグによりバイナリファイルの変更もカバー
  await $`git diff --cached --binary > ${targetDir}/staged.patch`;
  await $`git diff --binary > ${targetDir}/unstaged.patch`;

  // 3. メタデータの保存
  const headHash = await $`git rev-parse HEAD`.text();
  await Bun.write(`${targetDir}/info.json`, JSON.stringify({ headHash, timestamp: Date.now() }));
}

```

#### Restore (復元)

```typescript
async function restore(sourceDir: string) {
  // 1. ワークスペースのクリーンアップ
  await $`git reset --hard HEAD`;
  await $`git clean -fd`;

  // 2. Untracked files の展開
  if (await Bun.file(`${sourceDir}/untracked.tar.gz`).exists()) {
    await $`tar -xzf ${sourceDir}/untracked.tar.gz`;
  }

  // 3. パッチの適用
  // git apply は一部失敗しても可能な限り適用する --allow-empty などの制御が可能
  if (await Bun.file(`${sourceDir}/staged.patch`).exists()) {
    await $`git apply --cached ${sourceDir}/staged.patch`.quiet();
  }
  if (await Bun.file(`${sourceDir}/unstaged.patch`).exists()) {
    await $`git apply ${sourceDir}/unstaged.patch`.quiet();
  }
}

```

---

## 5. 懸念点とリスク分析 (Update)

### 5.1 リスク: Windows/POSIX間のパッチ互換性

* **内容:** Gitのパッチ形式は改行コード(LF/CRLF)に敏感。
* **対策:** `ccenv` 内部でGitを叩く際、`core.autocrlf` 設定を一時的に固定するか、Bun側でバイナリとしてパッチを扱うことで、環境依存のコンフリクトを最小化する。

---

## 6. テスト戦略 (Test Plan) - **Revised for bun:test**

### 6.1 Unit Testing (`bun test`)

* `describe`, `it`, `expect` を用いた標準的なテスト。
* `Bun.file` のモックを使用して、物理ディスクへの書き込みなしでメタデータ処理をテスト。

### 6.2 E2E Testing

* **Temporary Repo Setup:** `os.tmpdir()` 内に `git init` した一時リポジトリを作成。
* **Snapshot Validation:** 1.  ファイルをランダムに変更。
2.  `ccenv enter` 実行。
3.  変更が消えている（HEADに戻っている）ことを確認。
4.  `ccenv exit` 実行。
5.  変更が完全に元通りになっている（`git diff` が 0）ことを確認。

