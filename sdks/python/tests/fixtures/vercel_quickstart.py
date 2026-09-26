# Vercel Sandbox's Python SDK reference (vercel.com/docs/sandbox/python-sdk-reference,
# checked 23 September 2026), as its examples show it. scripts/dropin_e2e.py
# runs it on Runtime with only the import changed.
import asyncio

from vercel import sandbox


async def main() -> None:
    async with sandbox.create_sandbox() as box:
        result = await box.run_process(
            "python",
            ["-c", "print('Hello from Vercel Sandbox!')"],
            capture_output=True,
            check=True,
        )
        print(result.stdout)

        await box.fs.mkdir("workspace")
        await box.fs.write_text("workspace/input.txt", "hello\n")
        text = await box.fs.read_text("workspace/input.txt")
        print(text)

        process = await box.create_process(
            "sh",
            ["-lc", "for i in 1 2 3; do echo $i; sleep 1; done"],
        )
        assert process.stdout is not None
        async for line in process.stdout:
            print(line, end="")
        returncode = await process.wait()
        print("exit", returncode)


asyncio.run(main())
