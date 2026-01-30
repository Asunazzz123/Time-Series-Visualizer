# main.py
# 安装: pip install fastapi uvicorn numpy
import shutil
from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
from typing import List

from data import MultiSeriesData
app = FastAPI()
BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploaded_files"
UPLOAD_DIR.mkdir(exist_ok=True)

def _collect_csv_files() -> List[str]:
    candidates = []

    normal_dir = BASE_DIR / "data" / "normal"
    abnormal_dir = BASE_DIR / "data" / "abnormal"
    diag_dir = BASE_DIR / "data" / "DiagnosisData"
    utils_dir = diag_dir / "utils_csv"

    if normal_dir.exists():
        candidates.extend(sorted(normal_dir.glob("*.csv"))[:3])

    if abnormal_dir.exists():
        candidates.extend(sorted(abnormal_dir.glob("*.csv"))[:3])

    if not candidates and utils_dir.exists():
        candidates.extend(sorted(utils_dir.glob("*.csv"))[:3])

    if not candidates and diag_dir.exists():
        candidates.extend(sorted(diag_dir.glob("*.csv"))[:3])

    return [str(path) for path in candidates]


file_list = _collect_csv_files()
multi_data = MultiSeriesData(file_list)
# 允许跨域以便前端调试
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/upload")
async def upload_csv(file: UploadFile = File(...)):
    # 1. 定义保存路径
    file_location = UPLOAD_DIR / file.filename
    
    # 2. 将上传的文件流写入本地磁盘
    # 使用 shutil.copyfileobj 处理大文件更高效
    with open(file_location, "wb+") as file_object:
        shutil.copyfileobj(file.file, file_object)
    
    # 3. 解析并加载数据到内存中
    success = multi_data.add_file(str(file_location))
    
    if success:
        return {"message": f"Successfully uploaded and loaded {file.filename}"}
    else:
        return {"message": "Failed to parse file", "error": True}
    

@app.post("/clear")
async def clear_all_data():
    multi_data.clear_data()
    return {"message": "All series data cleared successfully"}


@app.get("/data")
def get_time_series():
    return multi_data.get_data()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)