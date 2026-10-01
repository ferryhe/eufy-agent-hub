@echo off
if "%~1"=="" (
  echo Usage: Import-Verification.cmd ^<legacy-verification.json^>
  exit /b 2
)
"%~dp0runtime\node\node.exe" "%~dp0scripts\release\import-verification.cjs" "%~f1"
if errorlevel 1 pause
