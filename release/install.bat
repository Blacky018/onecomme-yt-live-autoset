@echo off
chcp 65001 >nul
setlocal

rem YouTube 配信 URL 自動セット: わんコメのプラグインフォルダへコピーする
rem 既存の設定（state.json）は消さない（上書き更新にも使える）

set "SRC=%~dp0yt-live-autoset"
set "ONECOMME=%APPDATA%\onecomme"
set "DEST=%ONECOMME%\plugins\yt-live-autoset"

if not exist "%SRC%\plugin.js" (
  echo [エラー] yt-live-autoset フォルダが見つかりません。
  echo zip を「すべて展開」してから、展開したフォルダの install.bat を実行してください。
  goto :fail
)
if not exist "%ONECOMME%" (
  echo [エラー] わんコメのフォルダが見つかりません: %ONECOMME%
  echo わんコメを一度起動してから、もう一度実行してください。
  goto :fail
)

robocopy "%SRC%" "%DEST%" /E /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
  echo [エラー] コピーに失敗しました: %DEST%
  goto :fail
)

echo インストールしました: %DEST%
echo.
echo 次にすること:
echo   1. わんコメを再起動する（起動していなければ起動する）
echo   2. わんコメの「プラグイン」画面で「YouTube 配信 URL 自動セット（非公式）」を有効にする
echo   3. 設定画面を開く: http://localhost:11180/plugins/com.riito.yt-live-autoset/index.html
echo.
pause
exit /b 0

:fail
echo.
pause
exit /b 1
