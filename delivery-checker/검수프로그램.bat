@echo off
chcp 65001 >nul
title Road Ledger Delivery Checker
cd /d "%~dp0"

REM Use runtime\node.exe in this folder if present (no install needed), otherwise Node.js installed on this PC.
if exist "%~dp0runtime\node.exe" (
    "%~dp0runtime\node.exe" "%~dp0delivery-checker\server.js"
) else (
    node "%~dp0delivery-checker\server.js"
)
if errorlevel 1 (
    echo.
    echo The program ended with an error. Please check the messages above.
    pause
)
