#!/usr/bin/env python3
"""Create the exact Quiet River WeRSS overrides from the pinned upstream tree."""
import argparse
import pathlib
import shutil

PINNED_REVISION="d8feb6a42c6773d7374e03c487d3ae3426084af8"

def replace_once(path: pathlib.Path, old: bytes, new: bytes):
    data=path.read_bytes()
    count=data.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one contract match, found {count}")
    path.write_bytes(data.replace(old,new))

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--source",required=True)
    parser.add_argument("--output",required=True)
    args=parser.parse_args()
    source=pathlib.Path(args.source).resolve()
    output=pathlib.Path(args.output).resolve()
    if not (source/".git").exists():
        raise SystemExit("source must be the pinned upstream git checkout")
    output.mkdir(parents=True,exist_ok=True)
    for relative in ("main.py","apis/mps.py","apis/weread.py"):
        target=output/relative
        target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(source/relative,target)
    replace_once(output/"main.py",
        b'    print("\xe7\x8e\xaf\xe5\xa2\x83\xe5\x8f\x98\xe9\x87\x8f:")\r\n'
        b'    for k,v in os.environ.items():\r\n'
        b'        print(f"{k}={v}")\r\n',
        b'')

    replace_once(output/"apis/mps.py",
        b'async def update_mps(\r\n'
        b'     mp_id: str,\r\n'
        b'     start_page: int = 0,\r\n'
        b'     end_page: int = 1,\r\n'
        b'    current_user: dict = Depends(get_current_user_or_ak)\r\n'
        b'):',
        b'async def update_mps(\r\n'
        b'     mp_id: str,\r\n'
        b'     start_page: int = 0,\r\n'
        b'     end_page: int = 1\r\n'
        b'):')

    for old,new in (
        (b'def get_weread_qrcode(current_user=Depends(get_current_user)):\n',
         b'def get_weread_qrcode():\n'),
        (b'async def weread_qr_image(current_user=Depends(get_current_user)):\n',
         b'async def weread_qr_image():\n'),
        (b'async def weread_qr_status(current_user=Depends(get_current_user)):\n',
         b'async def weread_qr_status():\n'),
        (b'async def weread_qr_over(current_user=Depends(get_current_user)):\n',
         b'async def weread_qr_over():\n'),
    ):
        replace_once(output/"apis/weread.py",old,new)

    print(f"Prepared WeRSS overrides for {PINNED_REVISION}")

if __name__=="__main__":
    main()
