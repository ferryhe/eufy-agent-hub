@echo off
"%~dp0runtime\node\node.exe" "%~dp0scripts\release\launcher.cjs" stop
if errorlevel 1 pause
