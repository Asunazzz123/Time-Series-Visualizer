# main.py
# 安装: pip install fastapi uvicorn numpy scipy
import shutil
from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
from typing import List, Dict, Optional
from pydantic import BaseModel
import numpy as np
from scipy import signal

from data import MultiSeriesData


# ============ Pydantic 请求模型 ============
class AlignRequest(BaseModel):
    """对齐请求的数据模型 - 支持动态分组"""
    groups: Dict[str, List[str]]  # {"Normal": ["s1"], "跳料异常": ["s2"], "叠料异常": ["s3"]}
    cut_ranges: Optional[Dict[str, List[int]]] = None  # {"series1": [start, end], ...}
    reference_group: str = "Normal"  # 参考组（所有其他组将对齐到这个组）


# ============ 对齐算法服务 ============
class AlignmentService:
    """分层交叉相关对齐服务"""
    
    @staticmethod
    def cross_correlate_lag(template: np.ndarray, target: np.ndarray) -> int:
        """
        使用交叉相关计算 target 相对于 template 的最佳偏移量。
        返回值: 正值表示 target 需要右移，负值表示需要左移。
        """
        # 归一化信号以获得更稳定的相关性
        template_norm = template - np.mean(template)
        target_norm = target - np.mean(target)
        
        # 使用 'full' 模式进行交叉相关
        correlation = signal.correlate(template_norm, target_norm, mode='full')
        
        # 找到最大相关性的索引
        max_idx = np.argmax(correlation)
        
        # 计算偏移量: 当 max_idx == len(target) - 1 时，偏移为 0
        lag = max_idx - (len(target) - 1)
        
        return int(lag)
    
    @staticmethod
    def get_signal_segment(
        series_data: Dict[str, List[float]], 
        cut_range: Optional[List[int]] = None
    ) -> np.ndarray:
        """获取信号的 Y 值片段用于对齐计算"""
        y_data = np.array(series_data['y'], dtype=np.float32)
        
        if cut_range and len(cut_range) == 2:
            start, end = cut_range
            start = max(0, start)
            end = min(len(y_data), end)
            return y_data[start:end]
        
        return y_data
    
    def align_group(
        self,
        group_series: List[str],
        all_data: Dict[str, Dict[str, List[float]]],
        cut_ranges: Optional[Dict[str, List[int]]] = None
    ) -> Dict[str, int]:
        """
        Step A: 组内对齐
        将组内所有信号对齐到该组的第一个信号（模板）。
        返回每个信号相对于模板的偏移量。
        """
        if not group_series:
            return {}
        
        offsets: Dict[str, int] = {}
        
        # 第一个信号作为模板，偏移量为 0
        template_name = group_series[0]
        if template_name not in all_data:
            return {}
            
        template_cut = cut_ranges.get(template_name) if cut_ranges else None
        template_signal = self.get_signal_segment(all_data[template_name], template_cut)
        
        offsets[template_name] = 0
        
        # 对齐组内其他信号
        for series_name in group_series[1:]:
            if series_name not in all_data:
                offsets[series_name] = 0
                continue
            
            target_cut = cut_ranges.get(series_name) if cut_ranges else None
            target_signal = self.get_signal_segment(all_data[series_name], target_cut)
            
            # 计算偏移量
            lag = self.cross_correlate_lag(template_signal, target_signal)
            offsets[series_name] = lag
        
        return offsets
    
    def hierarchical_align(
        self,
        groups: Dict[str, List[str]],
        all_data: Dict[str, Dict[str, List[float]]],
        cut_ranges: Optional[Dict[str, List[int]]] = None,
        reference_group: str = "Normal"
    ) -> Dict[str, int]:
        """
        分层对齐算法（支持多个动态分组）:
        Step A: 组内对齐 - 每个组内的信号对齐到该组的模板（第一个信号）
        Step B: 组间对齐 - 将所有非参考组的模板对齐到参考组的模板，
                          并将该偏移量应用到该组所有信号
        """
        final_offsets: Dict[str, int] = {}
        group_templates: Dict[str, str] = {}
        
        # Step A: 组内对齐
        for group_name, series_list in groups.items():
            if not series_list:
                continue
            
            group_offsets = self.align_group(series_list, all_data, cut_ranges)
            final_offsets.update(group_offsets)
            
            # 记录每个组的模板（第一个信号）
            group_templates[group_name] = series_list[0]
        
        # Step B: 组间对齐（将所有非参考组对齐到参考组）
        if reference_group not in group_templates or reference_group not in groups:
            # 如果参考组不存在，直接返回组内对齐结果
            return final_offsets
        
        reference_template = group_templates[reference_group]
        if reference_template not in all_data:
            return final_offsets
        
        # 获取参考组模板信号
        ref_cut = cut_ranges.get(reference_template) if cut_ranges else None
        reference_signal = self.get_signal_segment(all_data[reference_template], ref_cut)
        
        # 对每个非参考组进行组间对齐
        for group_name, series_list in groups.items():
            if group_name == reference_group or not series_list:
                continue
            
            if group_name not in group_templates:
                continue
                
            other_template = group_templates[group_name]
            if other_template not in all_data:
                continue
            
            # 获取其他组模板信号
            other_cut = cut_ranges.get(other_template) if cut_ranges else None
            other_signal = self.get_signal_segment(all_data[other_template], other_cut)
            
            # 计算组间偏移（该组模板相对于参考组模板）
            inter_group_lag = self.cross_correlate_lag(reference_signal, other_signal)
            
            # 将组间偏移应用到该组的所有信号
            for series_name in series_list:
                if series_name in final_offsets:
                    final_offsets[series_name] += inter_group_lag
        
        return final_offsets


# 创建对齐服务实例
alignment_service = AlignmentService()
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


@app.post("/align")
async def align_signals(request: AlignRequest):
    """
    分层交叉相关对齐端点（支持多个动态分组）
    
    请求体:
    {
        "groups": {
            "Normal": ["series1", "series2"],
            "跳料异常": ["series3"],
            "叠料异常": ["series4"]
        },
        "cut_ranges": {
            "series1": [0, 1000],
            "series2": [100, 1100]
        },
        "reference_group": "Normal"
    }
    
    响应:
    {
        "offsets": {
            "series1": 0,
            "series2": 15,
            "series3": -23,
            "series4": 8
        }
    }
    """
    try:
        all_data = multi_data.get_data()
        
        offsets = alignment_service.hierarchical_align(
            groups=request.groups,
            all_data=all_data,
            cut_ranges=request.cut_ranges,
            reference_group=request.reference_group
        )
        
        return {"offsets": offsets}
    
    except Exception as e:
        return {"error": str(e), "offsets": {}}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)