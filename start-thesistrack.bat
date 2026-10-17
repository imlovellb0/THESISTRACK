@echo off
rem Double-click to start ThesisTrack for a demo. Start MySQL in the XAMPP Control Panel first.
cd /d "%~dp0"
echo Starting ThesisTrack... keep this window open. Close it to stop the server.
start "" http://localhost:3000
call npm start
pause
