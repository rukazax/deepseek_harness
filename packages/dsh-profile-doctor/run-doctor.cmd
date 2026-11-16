@echo off
rem dsh-profile-doctor: run the DeepSeek Harness profile check.
rem Node comes from the DSH installation, so no node on PATH is required.
setlocal
set "DSH_INSTALL=%PROFILE_DOCTOR_INSTALL%"
if not defined DSH_INSTALL set "DSH_INSTALL=%LOCALAPPDATA%\Programs\DeepSeek Harness"
if not exist "%DSH_INSTALL%\resources\app.asar" (
  echo DeepSeek Harness installation not found: "%DSH_INSTALL%"
  echo Set PROFILE_DOCTOR_INSTALL or run: node doctor.mjs --install "<path>"
  exit /b 2
)
set "NODE_EXE="
for /d %%D in ("%DSH_INSTALL%\resources\runtime\primary-runtime\dependencies\node*") do (
  if exist "%%D\bin\node.exe" set "NODE_EXE=%%D\bin\node.exe"
)
if not defined NODE_EXE if exist "%DSH_INSTALL%\resources\runtime\bin\node.exe" set "NODE_EXE=%DSH_INSTALL%\resources\runtime\bin\node.exe"
if not defined NODE_EXE (
  echo node.exe not found under "%DSH_INSTALL%\resources\runtime".
  exit /b 2
)
"%NODE_EXE%" "%~dp0doctor.mjs" %*
exit /b %ERRORLEVEL%
