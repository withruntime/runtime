# Daytona's Python quickstart and its process, session and file-system guides
# (daytona.io/docs, checked 23 September 2026), as their docs show them.
# scripts/dropin_e2e.py runs it on Runtime with only the import changed.
from daytona import Daytona, SessionExecuteRequest

daytona = Daytona()
sandbox = daytona.create()

try:
    response = sandbox.process.code_run('print("Hello from Python")')
    print(response.result)

    response = sandbox.process.exec('echo "Hello, World!"')
    print(response.exit_code, response.result)

    sandbox.fs.upload_file(b"Hello, World!", "example.txt")
    content = sandbox.fs.download_file("example.txt")
    print(content.decode("utf-8"))

    session_id = "interactive-session"
    sandbox.process.create_session(session_id)
    sandbox.process.execute_session_command(session_id, SessionExecuteRequest(command="export STEP=two"))
    command = sandbox.process.execute_session_command(
        session_id, SessionExecuteRequest(command="echo step one && echo step $STEP")
    )
    print(command.stdout)
    sandbox.process.delete_session(session_id)
finally:
    daytona.delete(sandbox)
