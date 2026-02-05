# main.py
# 安装: pip install fastapi uvicorn numpy scipy
import shutil
from fastapi import FastAPI, UploadFile, File, Form, Query
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
from typing import List, Dict, Optional
from pydantic import BaseModel
import numpy as np
from scipy import signal

from data import MultiSeriesData, MultiChannelFormatError


# ============ Pydantic 请求模型 ============
class AlignRequest(BaseModel):
    """对齐请求的数据模型 - 支持动态分组"""
    groups: Dict[str, List[str]]  # {"Normal": ["s1"], "跳料异常": ["s2"], "叠料异常": ["s3"]}
    cut_ranges: Optional[Dict[str, List[int]]] = None  # {"series1": [start, end], ...}
    reference_group: str = "Normal"  # 参考组（所有其他组将对齐到这个组）


class ChannelNameRequest(BaseModel):
    """通道命名请求"""
    channel_names: Dict[str, str]  # {"AI2-01": "加速度信号1", ...}


class ChannelOffsetRequest(BaseModel):
    """通道偏移量请求"""
    channel_id: str
    offset: float


class ChannelCutRangeRequest(BaseModel):
    """通道切割范围请求"""
    channel_id: str
    start: int
    end: int


class DatasetNameRequest(BaseModel):
    """多通道数据集命名请求"""
    dataset_id: str
    name: str


class MultiChannelAlignRequest(BaseModel):
    """多通道数据集对齐请求"""
    dataset_ids: List[str]
    channel_id: str
    reference_dataset_id: Optional[str] = None
    cut_range: Optional[List[float]] = None
    target_points: Optional[int] = None


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

# 【大文件配置】
MAX_UPLOAD_SIZE = 1024 * 1024 * 1024  # 1GB 最大上传限制
DEFAULT_DOWNSAMPLE_POINTS = 5000  # 默认降采样点数


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
async def upload_csv(
    file: UploadFile = File(...),
    multi_channel_mode: bool = Form(False)
):
    """
    上传CSV文件
    - 支持大文件流式写入
    - 多通道模式下自动检测大文件并启用缓存
    """
    # 1. 定义保存路径
    file_location = UPLOAD_DIR / file.filename
    
    # 2. 流式写入磁盘（支持大文件）
    total_size = 0
    chunk_size = 1024 * 1024  # 1MB chunks
    
    with open(file_location, "wb") as file_object:
        while True:
            chunk = await file.read(chunk_size)
            if not chunk:
                break
            total_size += len(chunk)
            if total_size > MAX_UPLOAD_SIZE:
                file_object.close()
                file_location.unlink()  # 删除不完整的文件
                return {"message": f"文件过大，超过 {MAX_UPLOAD_SIZE // (1024*1024)}MB 限制", "error": True}
            file_object.write(chunk)
    
    # 3. 更新多通道模式
    multi_data.set_multi_channel_mode(multi_channel_mode)
    
    # 4. 解析并加载数据
    try:
        result = multi_data.add_file(str(file_location), multi_channel_mode=multi_channel_mode)
        
        if result:
            if multi_channel_mode and isinstance(result, dict):
                dataset = result
                return {
                    "message": f"Successfully uploaded and loaded {file.filename}",
                    "multi_channel_mode": True,
                    "dataset": dataset,
                    "dataset_id": dataset.get("id"),
                    "dataset_name": dataset.get("name"),
                    "channels": dataset.get("channels", []),
                    "is_large_file": dataset.get("is_large_file", False),
                    "total_rows": dataset.get("total_rows", 0),
                    "time_range": dataset.get("time_range", [0, 0]),
                    "file_size_mb": dataset.get("file_size_mb", round(total_size / (1024 * 1024), 2))
                }
            else:
                # 单通道模式
                metadata = multi_data.get_metadata()
                return {
                    "message": f"Successfully uploaded and loaded {file.filename}",
                    "multi_channel_mode": False,
                    "channels": multi_data.get_channel_list(),
                    "is_large_file": multi_data.is_large_file,
                    "total_rows": metadata.get("total_rows", 0),
                    "time_range": metadata.get("time_range", [0, 0]),
                    "file_size_mb": round(total_size / (1024 * 1024), 2)
                }
        else:
            return {"message": "Failed to parse file", "error": True}
    except MultiChannelFormatError as e:
        return {"message": str(e), "error": True, "format_error": True}
    

@app.post("/clear")
async def clear_all_data():
    """清空所有数据，包括内存数据和已上传的CSV文件"""
    # 1. 清空内存数据
    multi_data.clear_data()
    
    # 2. 删除 uploaded_files 目录中的所有 CSV 文件
    deleted_files = []
    if UPLOAD_DIR.exists():
        for file in UPLOAD_DIR.glob("*.csv"):
            try:
                file.unlink()
                deleted_files.append(file.name)
            except Exception as e:
                print(f"Failed to delete {file.name}: {e}")
    
    return {
        "message": "All series data cleared successfully",
        "deleted_files": deleted_files,
        "files_deleted_count": len(deleted_files)
    }


@app.get("/data")
def get_time_series():
    """获取全量数据（仅适用于小文件单通道模式）"""
    return multi_data.get_data()


@app.get("/metadata")
def get_metadata(dataset_id: Optional[str] = Query(None, description="多通道数据集ID")):
    """获取数据元信息"""
    return multi_data.get_metadata(dataset_id=dataset_id)


@app.get("/channel-data/{channel_id}")
def get_channel_data(
    channel_id: str,
    dataset_id: Optional[str] = Query(None, description="多通道数据集ID"),
    start_idx: int = Query(0, description="起始索引"),
    end_idx: Optional[int] = Query(None, description="结束索引"),
    target_points: int = Query(DEFAULT_DOWNSAMPLE_POINTS, description="目标点数")
):
    """
    【大文件模式】按需获取指定通道的降采样数据
    
    - channel_id: 通道ID (如 AI2-01)
    - start_idx: 起始数据点索引
    - end_idx: 结束数据点索引
    - target_points: 降采样目标点数
    """
    try:
        if multi_data.get_multi_channel_mode():
            data = multi_data.get_multi_channel_channel_data(
                dataset_id, channel_id, start_idx, end_idx, target_points
            )
        else:
            data = multi_data.get_channel_data_downsampled(
                channel_id, start_idx, end_idx, target_points
            )
        return {
            "channel_id": channel_id,
            "dataset_id": dataset_id or multi_data.get_active_dataset_id(),
            "data": data,
            "point_count": len(data.get("x", [])),
            "downsampled": len(data.get("x", [])) < (end_idx - start_idx if end_idx else 0)
        }
    except Exception as e:
        return {"error": str(e), "data": {"x": [], "y": []}}


@app.get("/channel-data-by-time/{channel_id}")
def get_channel_data_by_time(
    channel_id: str,
    dataset_id: Optional[str] = Query(None, description="多通道数据集ID"),
    start_time: float = Query(0.0, description="起始时间"),
    end_time: float = Query(1e10, description="结束时间"),
    target_points: int = Query(DEFAULT_DOWNSAMPLE_POINTS, description="目标点数")
):
    """
    【大文件模式】根据时间范围获取降采样数据
    
    - channel_id: 通道ID
    - start_time: 起始时间
    - end_time: 结束时间  
    - target_points: 降采样目标点数
    """
    try:
        if multi_data.get_multi_channel_mode():
            data = multi_data.get_multi_channel_channel_data_by_time(
                dataset_id, channel_id, start_time, end_time, target_points
            )
        else:
            data = multi_data.get_channel_data_by_time_range(
                channel_id, start_time, end_time, target_points
            )
        return {
            "channel_id": channel_id,
            "dataset_id": dataset_id or multi_data.get_active_dataset_id(),
            "data": data,
            "point_count": len(data.get("x", [])),
            "time_range": [start_time, end_time]
        }
    except Exception as e:
        return {"error": str(e), "data": {"x": [], "y": []}}


@app.get("/channels")
def get_channels():
    """获取当前所有通道信息"""
    metadata = multi_data.get_metadata()
    return {
        "channels": multi_data.get_channel_list(),
        "channel_names": multi_data.get_channel_names(),
        "multi_channel_mode": multi_data.get_multi_channel_mode(),
        "is_large_file": multi_data.is_large_file,
        "total_rows": metadata.get("total_rows", 0),
        "time_range": metadata.get("time_range", [0, 0])
    }


@app.get("/multi-channel/datasets")
def get_multi_channel_datasets():
    """获取多通道模式的所有数据集元信息"""
    return {"datasets": multi_data.get_multi_channel_datasets()}


@app.get("/multi-channel/data/{dataset_id}")
def get_multi_channel_dataset_data(dataset_id: str):
    """获取指定多通道数据集的全量数据（仅小文件）"""
    data = multi_data.get_multi_channel_dataset_data(dataset_id)
    datasets = multi_data.get_multi_channel_datasets()
    dataset_info = next((d for d in datasets if d.get("id") == dataset_id), None)
    is_large = dataset_info.get("is_large_file", False) if dataset_info else False
    return {"dataset_id": dataset_id, "data": data, "is_large_file": is_large}


@app.post("/multi-channel/dataset-name")
async def update_dataset_name(request: DatasetNameRequest):
    """更新多通道数据集名称"""
    updated = multi_data.update_dataset_name(request.dataset_id, request.name)
    if not updated:
        return {"error": "Dataset not found"}
    return {"message": "Dataset name updated", "dataset_id": request.dataset_id, "name": request.name}


@app.post("/multi-channel/align-datasets")
async def align_multi_channel_datasets(request: MultiChannelAlignRequest):
    """
    多通道模式：对齐多个数据集（基于指定通道的互相关）
    """
    dataset_ids = request.dataset_ids or []
    if len(dataset_ids) < 2:
        return {"error": "Need at least two datasets to align", "offsets": {}}

    reference_id = request.reference_dataset_id or dataset_ids[0]
    if reference_id not in dataset_ids:
        reference_id = dataset_ids[0]

    cut_range = request.cut_range if request.cut_range and len(request.cut_range) == 2 else None
    start_time = float(cut_range[0]) if cut_range else None
    end_time = float(cut_range[1]) if cut_range else None
    target_points = request.target_points or DEFAULT_DOWNSAMPLE_POINTS

    ref_series = multi_data.get_alignment_series(
        reference_id, request.channel_id, start_time, end_time, target_points
    )
    if not ref_series:
        return {"error": "Reference dataset or channel not found", "offsets": {}}

    ref_x, ref_y = ref_series
    if len(ref_x) < 2 or len(ref_y) < 2:
        return {"error": "Reference dataset has insufficient data", "offsets": {}}

    # 使用参考数据集的时间步长估算时间偏移
    dt = float(np.median(np.diff(ref_x))) if len(ref_x) > 1 else 1.0
    if not np.isfinite(dt) or dt == 0:
        dt = 1.0

    offsets: Dict[str, float] = {reference_id: 0.0}

    for dataset_id in dataset_ids:
        if dataset_id == reference_id:
            continue
        target_series = multi_data.get_alignment_series(
            dataset_id, request.channel_id, start_time, end_time, target_points
        )
        if not target_series:
            offsets[dataset_id] = 0.0
            continue

        _, target_y = target_series
        if len(target_y) < 2:
            offsets[dataset_id] = 0.0
            continue

        lag = alignment_service.cross_correlate_lag(ref_y, target_y)
        offsets[dataset_id] = float(lag * dt)

    return {
        "offsets": offsets,
        "reference_dataset_id": reference_id,
        "channel_id": request.channel_id
    }


@app.post("/channel-names")
async def update_channel_names(request: ChannelNameRequest):
    """更新通道命名"""
    for channel_id, display_name in request.channel_names.items():
        multi_data.set_channel_name(channel_id, display_name)
    return {"message": "Channel names updated", "channel_names": multi_data.get_channel_names()}


@app.get("/channel-names")
def get_channel_names():
    """获取通道命名映射"""
    return multi_data.get_channel_names()


@app.post("/channel-offset")
async def set_channel_offset(request: ChannelOffsetRequest):
    """设置单个通道的偏移量"""
    multi_data.set_channel_offset(request.channel_id, request.offset)
    return {"message": f"Offset for {request.channel_id} set to {request.offset}"}


@app.get("/channel-offsets")
def get_channel_offsets():
    """获取所有通道偏移量"""
    return multi_data.get_channel_offsets()


@app.post("/channel-cut-range")
async def set_channel_cut_range(request: ChannelCutRangeRequest):
    """设置单个通道的切割范围"""
    multi_data.set_channel_cut_range(request.channel_id, request.start, request.end)
    return {"message": f"Cut range for {request.channel_id} set to [{request.start}, {request.end}]"}


@app.get("/channel-cut-ranges")
def get_channel_cut_ranges():
    """获取所有通道切割范围"""
    return multi_data.get_channel_cut_ranges()


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
