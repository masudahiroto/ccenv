#!/bin/bash

# --- 設定 ---
WORK_DIR="/tmp/ccenv-demo"
INTERVAL=0.5
TYPE_SPEED=0.03

# --- 引数チェック ---
MODE=$1
if [[ "$MODE" != "prime" && "$MODE" != "fib" ]]; then
    echo "Usage: $0 [prime|fib]"
    exit 1
fi

# --- ヘルパー関数 ---

function type_text() {
    text="$1"
    for (( i=0; i<${#text}; i++ )); do
        echo -n "${text:$i:1}"
        sleep $TYPE_SPEED
    done
}

function run() {
    cmd="$1"
    
    # プロンプトの構築
    if [ -n "$CCENV_ACTIVE" ]; then
        prompt="(\033[1;32m$CCENV_ACTIVE\033[0m) $ "
    else
        prompt="$ "
    fi

    echo -ne "$prompt"
    type_text "$cmd"
    echo ""
    
    # 実行
    eval "$cmd"
    
    sleep $INTERVAL
}

# --- メイン処理 ---

# 1. ディレクトリ準備
mkdir -p "$WORK_DIR"
cd "$WORK_DIR" || exit

run pwd

# Git初期化
if [ ! -d ".git" ]; then
    git init -q
    echo "print('This is host')" > main.py
    git add main.py
    git commit -m "Initial commit" -q > /dev/null 2>&1
fi

# 2. Hooksのインストール
if [ ! -d ".gemini" ]; then
    run "ccenv install gemini-cli"
fi

# 3. シナリオ

# 前回のゴミ掃除
if [ -d ".ccenv/envs/env-$MODE" ]; then
    ccenv delete env-$MODE >/dev/null 2>&1
fi

run "ccenv create env-$MODE"

run 'eval "$(ccenv activate env-'$MODE')"'

# AIへのプロンプト
if [ "$MODE" == "prime" ]; then
    PROMPT="Create a Python script named 'main.py' that calculates and prints prime numbers from 1 to 50. Output only the code."
else
    PROMPT="Create a Python script named 'main.py' that calculates and prints the first 15 Fibonacci numbers. Output only the code."
fi

# gemini実行
run "gemini -i \"$PROMPT\""

# 実行
run "ccenv run -- python3 main.py"

# 中身確認
run "ccenv run -- cat main.py"

echo -e "\n--- Demo Finished ---"
