@echo off
rem ===================  WINDOW A  —  master branch  —  port 8000  ===================
rem This is the MAIN / product window. The side window is B (mapstructor-B, :8001).
title  WINDOW A  --  master  --  http://localhost:8000
color 0A
echo(
echo   ==============================================================
echo     W I N D O W   A     (main / product)
echo     folder : mapstructor.github.io
echo     branch : master
echo     url    : http://localhost:8000
echo   ==============================================================
echo(
cd /d "%~dp0"
python -m http.server 8000
