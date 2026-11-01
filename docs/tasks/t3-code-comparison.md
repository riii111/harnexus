# タスク: harnexus と T3 Code の比較調査

タスクID: t3-code-comparison
依頼元: リポジトリowner（統括役のセッション経由）

## 目的

harnexus と T3 Code（pingdotgg/t3code、Codex などのコーディングエージェント向けGUI）の違いを調べ、ownerへの報告にまとめる。

## 成果物

`docs/research/t3-code-comparison.md` に日本語の比較レポートを書く。
次の観点を含める。どれも根拠（harnexusはファイルパス、T3 CodeはURL）を付ける。

- 目的と位置づけ（何を解決するツールか）
- アーキテクチャ（Codex App への組み込みか独立アプリか、エージェントとの接続方式）
- 対応エージェント・モデルと認証方式
- 主な機能（複数エージェントの協調、レビュー、セッション管理、Cloud連携など）
- 対応プラットフォームと導入手順
- 成熟度・ライセンス・開発状況
- harnexus から見た使い分けの指針

調べて確かめられなかった点は推測と分けて書く。

## 進めてよい範囲

- 作業branchを作り、レポートをcommitしてpushする。
- task-review-cycle の「Claude CodeのCloud」に従い、Codex reviewer で LGTM まで反復する。
- Draft PR は作らない。PR購読もしない。
- 完了したら、レポートのパス・branch・最終head SHA・reviewerの判定を `send_message`（`@parent`）で統括役へ報告する。

## 制約

- harnexus のソースコードは変更しない。
- 外部リポジトリへの書き込みはしない。
