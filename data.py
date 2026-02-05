import csv
import os
import uuid
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import numpy as np

# 多通道数据格式定义（16通道）
MULTI_CHANNEL_HEADERS = ["time[s]"] + [f"AI2-{str(i).zfill(2)}" for i in range(1, 17)]
EXPECTED_CHANNEL_COUNT = 16

# 大文件处理配置
LARGE_FILE_THRESHOLD = 50 * 1024 * 1024  # 50MB以上视为大文件
DEFAULT_DOWNSAMPLE_POINTS = 5000  # 默认降采样到5000个点
CACHE_DIR = Path(__file__).resolve().parent / ".cache"


class MultiChannelFormatError(Exception):
    """多通道文件格式错误异常"""
    pass


def validate_multi_channel_format(headers: List[str]) -> Tuple[bool, str]:
    """
    验证多通道数据格式是否正确
    期望格式: time[s], AI2-01, AI2-02, ..., AI2-16
    返回: (是否有效, 错误消息)
    """
    if len(headers) != len(MULTI_CHANNEL_HEADERS):
        return False, f"列数不正确，期望 {len(MULTI_CHANNEL_HEADERS)} 列，实际 {len(headers)} 列"
    
    # 检查 time 列（移除可能的BOM字符和空白）
    first_col = headers[0].strip().lstrip('\ufeff').lower()
    if first_col != "time[s]":
        return False, f"第一列应为 'time[s]'，实际为 '{headers[0]}'"
    
    # 检查每个 AI2-xx 列
    for i in range(1, 17):
        expected = f"AI2-{str(i).zfill(2)}"
        actual = headers[i].strip() if i < len(headers) else "缺失"
        if actual != expected:
            return False, f"第 {i+1} 列应为 '{expected}'，实际为 '{actual}'"
    
    return True, ""


def lttb_downsample(x: np.ndarray, y: np.ndarray, target_points: int) -> Tuple[np.ndarray, np.ndarray]:
    """
    LTTB (Largest-Triangle-Three-Buckets) 降采样算法
    保留数据形状的智能降采样，适合时序数据可视化
    
    Args:
        x: 时间序列
        y: 数值序列
        target_points: 目标点数
    
    Returns:
        降采样后的 (x, y)
    """
    n = len(x)
    if n <= target_points:
        return x, y
    
    # 始终保留第一个和最后一个点
    sampled_x = [x[0]]
    sampled_y = [y[0]]
    
    # 计算桶大小
    bucket_size = (n - 2) / (target_points - 2)
    
    a = 0  # 上一个选中的点的索引
    
    for i in range(target_points - 2):
        # 计算当前桶的范围
        bucket_start = int((i + 1) * bucket_size) + 1
        bucket_end = int((i + 2) * bucket_size) + 1
        bucket_end = min(bucket_end, n - 1)
        
        # 计算下一个桶的平均点
        next_bucket_start = int((i + 2) * bucket_size) + 1
        next_bucket_end = int((i + 3) * bucket_size) + 1
        next_bucket_end = min(next_bucket_end, n)
        
        if next_bucket_start < n:
            avg_x = np.mean(x[next_bucket_start:next_bucket_end])
            avg_y = np.mean(y[next_bucket_start:next_bucket_end])
        else:
            avg_x = x[-1]
            avg_y = y[-1]
        
        # 在当前桶中找到形成最大三角形面积的点
        max_area = -1
        max_idx = bucket_start
        
        for j in range(bucket_start, bucket_end):
            # 计算三角形面积
            area = abs(
                (x[a] - avg_x) * (y[j] - y[a]) -
                (x[a] - x[j]) * (avg_y - y[a])
            ) * 0.5
            
            if area > max_area:
                max_area = area
                max_idx = j
        
        sampled_x.append(x[max_idx])
        sampled_y.append(y[max_idx])
        a = max_idx
    
    # 添加最后一个点
    sampled_x.append(x[-1])
    sampled_y.append(y[-1])
    
    return np.array(sampled_x, dtype=np.float32), np.array(sampled_y, dtype=np.float32)


class TimeSeriesData:
    def __init__(self, filename: str, series_prefix: Optional[str] = None, multi_channel_mode: bool = False):
        self.filename = filename
        self.series_prefix = series_prefix or Path(filename).stem
        self.multi_channel_mode = multi_channel_mode
        self.channel_names: Dict[str, str] = {}  # 通道别名映射 {"AI2-01": "加速度信号1"}
        self.data = self.load_data()

    def load_data(self) -> Dict[str, Dict[str, List[float]]]:
        data: Dict[str, Dict[str, List[float]]] = {}

        with open(self.filename, 'r', encoding='utf-8') as csvfile:
            reader = csv.reader(csvfile)
            rows = [row for row in reader if row]

        if not rows:
            return data

        first_row = rows[0]
        has_header = False
        try:
            for cell in first_row:
                float(cell)
        except ValueError:
            has_header = True

        if has_header:
            headers = [h.strip() for h in first_row]
            data_rows = rows[1:]
        else:
            headers = []
            data_rows = rows

        if not data_rows:
            return data

        column_count = len(data_rows[0])

        # 多通道模式的格式校验
        if self.multi_channel_mode:
            is_valid, error_msg = validate_multi_channel_format(headers)
            if not is_valid:
                raise MultiChannelFormatError(f"文件格式不正确: {error_msg}")

        # 单列：当成单序列处理，x 用索引
        if column_count == 1:
            series_name = self.series_prefix
            data[series_name] = {"x": [], "y": []}
            for idx, row in enumerate(data_rows):
                data[series_name]["x"].append(float(idx))
                data[series_name]["y"].append(float(row[0]))
            return data

        # 多列
        time_index = None
        if headers:
            for idx, name in enumerate(headers):
                name_lower = name.lower().strip()
                if name_lower in {"time", "t", "timestamp", "time[s]"}:
                    time_index = idx
                    break

        # 生成列名
        if headers:
            column_names = headers
        else:
            column_names = [f"col_{i}" for i in range(column_count)]

        for col_idx, col_name in enumerate(column_names):
            if col_idx == time_index:
                continue
            # 多通道模式使用通道名作为key，单通道模式使用前缀
            if self.multi_channel_mode:
                series_name = col_name.strip()
            else:
                series_name = f"{self.series_prefix}:{col_name}"
            data[series_name] = {"x": [], "y": []}

        for row_idx, row in enumerate(data_rows):
            if time_index is not None:
                if time_index >= len(row) or row[time_index] == "":
                    continue
                x_value = float(row[time_index])
            else:
                x_value = float(row_idx)

            for col_idx, col_name in enumerate(column_names):
                if col_idx == time_index:
                    continue
                if col_idx >= len(row) or row[col_idx] == "":
                    continue
                if self.multi_channel_mode:
                    series_name = col_name.strip()
                else:
                    series_name = f"{self.series_prefix}:{col_name}"
                data[series_name]["x"].append(x_value)
                data[series_name]["y"].append(float(row[col_idx]))

        return data

    def get_data(self):
        return self.data
    
    def get_channel_list(self) -> List[str]:
        """获取所有通道名称列表"""
        return [key for key in self.data.keys()]


class MultiChannelLargeFileHandler:
    """
    多通道大文件处理器
    - 使用 numpy 分块读取 CSV
    - 缓存为 .npy 格式加速后续读取
    - 支持按需降采样
    """
    
    def __init__(self, filepath: str):
        self.filepath = Path(filepath)
        self.cache_dir = CACHE_DIR
        self.cache_dir.mkdir(exist_ok=True)
        
        # 数据元信息
        self.total_rows: int = 0
        self.channels: List[str] = []
        self.time_range: Tuple[float, float] = (0.0, 0.0)
        
        # numpy数组缓存路径
        self._cache_paths: Dict[str, Path] = {}
        
    def get_cache_path(self, channel_id: str) -> Path:
        """获取通道的缓存文件路径"""
        file_hash = str(hash(str(self.filepath) + str(os.path.getmtime(self.filepath))))[-8:]
        return self.cache_dir / f"{self.filepath.stem}_{channel_id}_{file_hash}.npy"
    
    def get_time_cache_path(self) -> Path:
        """获取时间列的缓存文件路径"""
        file_hash = str(hash(str(self.filepath) + str(os.path.getmtime(self.filepath))))[-8:]
        return self.cache_dir / f"{self.filepath.stem}_time_{file_hash}.npy"
    
    def is_cached(self) -> bool:
        """检查是否已有缓存"""
        time_cache = self.get_time_cache_path()
        if not time_cache.exists():
            return False
        # 检查至少一个通道的缓存
        for i in range(1, 17):
            channel_id = f"AI2-{str(i).zfill(2)}"
            if self.get_cache_path(channel_id).exists():
                return True
        return False
    
    def parse_and_cache(self, progress_callback=None) -> Dict[str, any]:
        """
        分块解析CSV并缓存为numpy格式
        返回元信息
        """
        import pandas as pd
        
        # 首先读取表头验证格式
        with open(self.filepath, 'r', encoding='utf-8') as f:
            header_line = f.readline().strip()
            headers = [h.strip() for h in header_line.split(',')]
        
        is_valid, error_msg = validate_multi_channel_format(headers)
        if not is_valid:
            raise MultiChannelFormatError(f"文件格式不正确: {error_msg}")
        
        self.channels = headers[1:]  # AI2-01 到 AI2-16
        
        # 使用 pandas 分块读取
        chunk_size = 100000  # 每次读取10万行
        time_data = []
        channel_data = {ch: [] for ch in self.channels}
        
        total_chunks = 0
        for chunk in pd.read_csv(self.filepath, chunksize=chunk_size, dtype=np.float64):
            total_chunks += 1
            
            # 收集时间列
            time_col = chunk.iloc[:, 0].values
            time_data.append(time_col)
            
            # 收集每个通道数据
            for i, channel_id in enumerate(self.channels):
                channel_data[channel_id].append(chunk.iloc[:, i + 1].values)
            
            if progress_callback:
                progress_callback(total_chunks)
        
        # 合并并保存为 numpy 格式
        time_array = np.concatenate(time_data).astype(np.float32)
        np.save(self.get_time_cache_path(), time_array)
        
        self.total_rows = len(time_array)
        self.time_range = (float(time_array[0]), float(time_array[-1]))
        
        for channel_id in self.channels:
            channel_array = np.concatenate(channel_data[channel_id]).astype(np.float32)
            np.save(self.get_cache_path(channel_id), channel_array)
            self._cache_paths[channel_id] = self.get_cache_path(channel_id)
        
        return {
            "total_rows": self.total_rows,
            "channels": self.channels,
            "time_range": self.time_range
        }
    
    def load_metadata(self) -> Dict[str, any]:
        """从缓存加载元信息"""
        time_array = np.load(self.get_time_cache_path())
        self.total_rows = len(time_array)
        self.time_range = (float(time_array[0]), float(time_array[-1]))
        self.channels = [f"AI2-{str(i).zfill(2)}" for i in range(1, 17)]
        return {
            "total_rows": self.total_rows,
            "channels": self.channels,
            "time_range": self.time_range
        }
    
    def get_channel_data(
        self, 
        channel_id: str, 
        start_idx: int = 0, 
        end_idx: Optional[int] = None,
        target_points: int = DEFAULT_DOWNSAMPLE_POINTS
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        获取指定通道的数据，支持范围切片和降采样
        
        Args:
            channel_id: 通道ID (如 "AI2-01")
            start_idx: 起始索引
            end_idx: 结束索引，None表示到末尾
            target_points: 目标点数，超过此数量将进行降采样
        
        Returns:
            (time_array, value_array) 降采样后的数据
        """
        # 加载时间数据
        time_cache = self.get_time_cache_path()
        if not time_cache.exists():
            raise FileNotFoundError(f"缓存文件不存在: {time_cache}")
        
        time_array = np.load(time_cache)
        
        # 加载通道数据
        channel_cache = self.get_cache_path(channel_id)
        if not channel_cache.exists():
            raise FileNotFoundError(f"通道缓存文件不存在: {channel_cache}")
        
        value_array = np.load(channel_cache)
        
        # 切片
        if end_idx is None:
            end_idx = len(time_array)
        
        time_slice = time_array[start_idx:end_idx]
        value_slice = value_array[start_idx:end_idx]
        
        # 降采样
        if len(time_slice) > target_points:
            time_slice, value_slice = lttb_downsample(time_slice, value_slice, target_points)
        
        return time_slice, value_slice
    
    def get_channel_data_by_time(
        self,
        channel_id: str,
        start_time: float,
        end_time: float,
        target_points: int = DEFAULT_DOWNSAMPLE_POINTS
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        根据时间范围获取通道数据
        """
        time_array = np.load(self.get_time_cache_path())
        
        # 找到时间范围对应的索引
        start_idx = np.searchsorted(time_array, start_time, side='left')
        end_idx = np.searchsorted(time_array, end_time, side='right')
        
        return self.get_channel_data(channel_id, start_idx, end_idx, target_points)


class MultiSeriesData:
    """
    多序列数据管理器
    - 单通道模式：全量加载
    - 多通道模式：支持大文件处理、按需降采样
    """
    
    def __init__(self, file_list: List[str]):
        self.file_list = file_list
        self.data: Dict[str, Dict[str, List[float]]] = {}
        self.multi_channel_mode: bool = False
        self.channel_names: Dict[str, str] = {}
        self.channel_offsets: Dict[str, float] = {}
        self.channel_cut_ranges: Dict[str, List[int]] = {}
        # 【多通道模式】多数据集存储
        self.multi_channel_datasets: Dict[str, Dict[str, any]] = {}
        self.multi_channel_order: List[str] = []
        
        # 【大文件处理】新增属性
        self.large_file_handler: Optional[MultiChannelLargeFileHandler] = None
        self.is_large_file: bool = False
        self.metadata: Dict[str, any] = {}
        
        # 初始化时加载已有文件（仅单通道模式）
        for file in file_list:
            self.add_file(file)

    def add_file(self, filepath: str, multi_channel_mode: bool = False):
        """动态添加单个文件的数据"""
        try:
            file_size = os.path.getsize(filepath)
            
            # 多通道模式：作为独立数据集处理
            if multi_channel_mode:
                return self.add_multi_channel_file(filepath)
            
            # 常规处理：小文件全量加载
            ts_data = TimeSeriesData(filepath, multi_channel_mode=multi_channel_mode)
            new_data = ts_data.get_data()
            if new_data:
                self.data.update(new_data)
                if filepath not in self.file_list:
                    self.file_list.append(filepath)
                for channel_name in new_data.keys():
                    if channel_name not in self.channel_names:
                        self.channel_names[channel_name] = channel_name
            return True
            
        except MultiChannelFormatError as e:
            print(f"Multi-channel format error: {e}")
            raise e
        except Exception as e:
            print(f"Error loading {filepath}: {e}")
            return False

    def _build_small_dataset_metadata(self, data: Dict[str, Dict[str, List[float]]]) -> Dict[str, any]:
        """根据小文件数据生成元信息"""
        total_rows = 0
        channels = list(data.keys())
        time_range = (0.0, 0.0)
        if channels and data[channels[0]]["x"]:
            x_data = data[channels[0]]["x"]
            total_rows = len(x_data)
            time_range = (float(x_data[0]), float(x_data[-1]))
        return {
            "total_rows": total_rows,
            "channels": channels,
            "time_range": time_range
        }

    def add_multi_channel_file(self, filepath: str) -> Dict[str, any]:
        """多通道模式：添加一个文件，作为独立数据集保存"""
        dataset_id = uuid.uuid4().hex
        filename = Path(filepath).name
        display_name = Path(filepath).stem
        file_size = os.path.getsize(filepath)

        dataset: Dict[str, any] = {
            "id": dataset_id,
            "name": display_name,
            "filename": filename,
            "filepath": filepath,
            "file_size_mb": round(file_size / (1024 * 1024), 2),
            "is_large_file": False,
            "metadata": {},
            "channels": [],
            "data": None,
            "large_file_handler": None,
        }

        # 大文件处理
        if file_size > LARGE_FILE_THRESHOLD:
            handler = MultiChannelLargeFileHandler(filepath)
            if handler.is_cached():
                metadata = handler.load_metadata()
            else:
                metadata = handler.parse_and_cache()
            dataset["is_large_file"] = True
            dataset["metadata"] = metadata
            dataset["channels"] = metadata.get("channels", [])
            dataset["large_file_handler"] = handler
        else:
            ts_data = TimeSeriesData(filepath, multi_channel_mode=True)
            new_data = ts_data.get_data()
            dataset["data"] = new_data
            metadata = self._build_small_dataset_metadata(new_data)
            dataset["metadata"] = metadata
            dataset["channels"] = metadata.get("channels", [])

        # 记录数据集
        self.multi_channel_datasets[dataset_id] = dataset
        self.multi_channel_order.append(dataset_id)
        if filepath not in self.file_list:
            self.file_list.append(filepath)

        return {
            "id": dataset_id,
            "name": dataset["name"],
            "filename": dataset["filename"],
            "is_large_file": dataset["is_large_file"],
            "total_rows": dataset["metadata"].get("total_rows", 0),
            "time_range": dataset["metadata"].get("time_range", (0.0, 0.0)),
            "channels": dataset["channels"],
            "file_size_mb": dataset["file_size_mb"],
        }

    def get_multi_channel_datasets(self) -> List[Dict[str, any]]:
        """获取所有多通道数据集的元信息列表"""
        datasets = []
        for dataset_id in self.multi_channel_order:
            dataset = self.multi_channel_datasets.get(dataset_id)
            if not dataset:
                continue
            datasets.append({
                "id": dataset_id,
                "name": dataset.get("name", dataset.get("filename", dataset_id)),
                "filename": dataset.get("filename", ""),
                "is_large_file": dataset.get("is_large_file", False),
                "total_rows": dataset.get("metadata", {}).get("total_rows", 0),
                "time_range": dataset.get("metadata", {}).get("time_range", (0.0, 0.0)),
                "channels": dataset.get("channels", []),
                "file_size_mb": dataset.get("file_size_mb", 0.0),
            })
        return datasets

    def _resolve_dataset(self, dataset_id: Optional[str] = None) -> Optional[Dict[str, any]]:
        if dataset_id and dataset_id in self.multi_channel_datasets:
            return self.multi_channel_datasets[dataset_id]
        if self.multi_channel_order:
            return self.multi_channel_datasets.get(self.multi_channel_order[-1])
        return None

    def get_active_dataset_id(self) -> Optional[str]:
        if self.multi_channel_order:
            return self.multi_channel_order[-1]
        return None

    def get_multi_channel_dataset_data(self, dataset_id: str) -> Dict[str, Dict[str, List[float]]]:
        """获取指定数据集的全量数据（仅适用于小文件）"""
        dataset = self.multi_channel_datasets.get(dataset_id)
        if not dataset:
            return {}
        if dataset.get("is_large_file"):
            return {}
        return dataset.get("data", {}) or {}

    def get_multi_channel_channel_data(
        self,
        dataset_id: Optional[str],
        channel_id: str,
        start_idx: int = 0,
        end_idx: Optional[int] = None,
        target_points: int = DEFAULT_DOWNSAMPLE_POINTS
    ) -> Dict[str, List[float]]:
        """多通道模式：获取指定数据集的通道数据，支持降采样"""
        dataset = self._resolve_dataset(dataset_id)
        if not dataset:
            return {"x": [], "y": []}
        if dataset.get("is_large_file") and dataset.get("large_file_handler"):
            time_array, value_array = dataset["large_file_handler"].get_channel_data(
                channel_id, start_idx, end_idx, target_points
            )
            return {"x": time_array.tolist(), "y": value_array.tolist()}

        data = dataset.get("data", {}) or {}
        if channel_id not in data:
            return {"x": [], "y": []}
        series = data[channel_id]
        x_data = np.array(series.get("x", []), dtype=np.float32)
        y_data = np.array(series.get("y", []), dtype=np.float32)

        if end_idx is None or end_idx > len(x_data):
            end_idx = len(x_data)
        x_slice = x_data[start_idx:end_idx]
        y_slice = y_data[start_idx:end_idx]

        if len(x_slice) > target_points:
            x_slice, y_slice = lttb_downsample(x_slice, y_slice, target_points)

        return {"x": x_slice.tolist(), "y": y_slice.tolist()}

    def get_multi_channel_channel_data_by_time(
        self,
        dataset_id: Optional[str],
        channel_id: str,
        start_time: float,
        end_time: float,
        target_points: int = DEFAULT_DOWNSAMPLE_POINTS
    ) -> Dict[str, List[float]]:
        """多通道模式：按时间范围获取数据集通道数据"""
        dataset = self._resolve_dataset(dataset_id)
        if not dataset:
            return {"x": [], "y": []}
        if dataset.get("is_large_file") and dataset.get("large_file_handler"):
            time_array, value_array = dataset["large_file_handler"].get_channel_data_by_time(
                channel_id, start_time, end_time, target_points
            )
            return {"x": time_array.tolist(), "y": value_array.tolist()}

        data = dataset.get("data", {}) or {}
        if channel_id not in data:
            return {"x": [], "y": []}

        x_data = data[channel_id].get("x", [])
        y_data = data[channel_id].get("y", [])
        filtered_x = []
        filtered_y = []
        for i, x in enumerate(x_data):
            if start_time <= x <= end_time:
                filtered_x.append(x)
                filtered_y.append(y_data[i])

        if len(filtered_x) > target_points:
            x_np = np.array(filtered_x, dtype=np.float32)
            y_np = np.array(filtered_y, dtype=np.float32)
            x_np, y_np = lttb_downsample(x_np, y_np, target_points)
            return {"x": x_np.tolist(), "y": y_np.tolist()}

        return {"x": filtered_x, "y": filtered_y}

    def update_dataset_name(self, dataset_id: str, name: str) -> bool:
        dataset = self.multi_channel_datasets.get(dataset_id)
        if not dataset:
            return False
        dataset["name"] = name
        return True

    def get_alignment_series(
        self,
        dataset_id: str,
        channel_id: str,
        start_time: Optional[float] = None,
        end_time: Optional[float] = None,
        target_points: int = DEFAULT_DOWNSAMPLE_POINTS
    ) -> Optional[Tuple[np.ndarray, np.ndarray]]:
        """
        获取用于对齐的 (time, value) 序列，支持时间范围与降采样
        """
        dataset = self.multi_channel_datasets.get(dataset_id)
        if not dataset:
            return None

        if dataset.get("is_large_file") and dataset.get("large_file_handler"):
            handler: MultiChannelLargeFileHandler = dataset["large_file_handler"]
            if start_time is not None or end_time is not None:
                start = start_time if start_time is not None else dataset.get("metadata", {}).get("time_range", (0.0, 0.0))[0]
                end = end_time if end_time is not None else dataset.get("metadata", {}).get("time_range", (0.0, 0.0))[1]
                time_array, value_array = handler.get_channel_data_by_time(
                    channel_id, start, end, target_points
                )
            else:
                time_array, value_array = handler.get_channel_data(
                    channel_id, 0, None, target_points
                )
            return time_array, value_array

        data = dataset.get("data", {}) or {}
        if channel_id not in data:
            return None

        x = np.array(data[channel_id].get("x", []), dtype=np.float32)
        y = np.array(data[channel_id].get("y", []), dtype=np.float32)
        if x.size == 0:
            return None

        if start_time is not None or end_time is not None:
            start = start_time if start_time is not None else float(x[0])
            end = end_time if end_time is not None else float(x[-1])
            start_idx = int(np.searchsorted(x, start, side="left"))
            end_idx = int(np.searchsorted(x, end, side="right"))
            x = x[start_idx:end_idx]
            y = y[start_idx:end_idx]

        if x.size > target_points:
            x, y = lttb_downsample(x, y, target_points)

        return x, y
    
    def get_channel_data_downsampled(
        self,
        channel_id: str,
        start_idx: int = 0,
        end_idx: Optional[int] = None,
        target_points: int = DEFAULT_DOWNSAMPLE_POINTS
    ) -> Dict[str, List[float]]:
        """
        【大文件模式】获取降采样后的通道数据
        """
        if self.is_large_file and self.large_file_handler:
            time_array, value_array = self.large_file_handler.get_channel_data(
                channel_id, start_idx, end_idx, target_points
            )
            return {
                "x": time_array.tolist(),
                "y": value_array.tolist()
            }
        else:
            # 常规模式：直接返回全量数据
            if channel_id in self.data:
                return self.data[channel_id]
            return {"x": [], "y": []}
    
    def get_channel_data_by_time_range(
        self,
        channel_id: str,
        start_time: float,
        end_time: float,
        target_points: int = DEFAULT_DOWNSAMPLE_POINTS
    ) -> Dict[str, List[float]]:
        """
        【大文件模式】根据时间范围获取降采样数据
        """
        if self.is_large_file and self.large_file_handler:
            time_array, value_array = self.large_file_handler.get_channel_data_by_time(
                channel_id, start_time, end_time, target_points
            )
            return {
                "x": time_array.tolist(),
                "y": value_array.tolist()
            }
        else:
            # 常规模式：手动筛选
            if channel_id not in self.data:
                return {"x": [], "y": []}
            
            x_data = self.data[channel_id]["x"]
            y_data = self.data[channel_id]["y"]
            
            filtered_x = []
            filtered_y = []
            for i, x in enumerate(x_data):
                if start_time <= x <= end_time:
                    filtered_x.append(x)
                    filtered_y.append(y_data[i])
            
            return {"x": filtered_x, "y": filtered_y}
    
    def get_metadata(self, dataset_id: Optional[str] = None) -> Dict[str, any]:
        """获取数据元信息"""
        if self.multi_channel_mode:
            dataset = self._resolve_dataset(dataset_id)
            if not dataset:
                return {
                    "total_rows": 0,
                    "channels": [],
                    "time_range": (0.0, 0.0),
                    "is_large_file": False
                }
            return {
                "total_rows": dataset.get("metadata", {}).get("total_rows", 0),
                "channels": dataset.get("channels", []),
                "time_range": dataset.get("metadata", {}).get("time_range", (0.0, 0.0)),
                "is_large_file": dataset.get("is_large_file", False)
            }
        else:
            # 计算常规数据的元信息
            total_rows = 0
            channels = list(self.data.keys())
            time_range = (0.0, 0.0)
            
            if channels and self.data[channels[0]]["x"]:
                x_data = self.data[channels[0]]["x"]
                total_rows = len(x_data)
                time_range = (x_data[0], x_data[-1])
            
            return {
                "total_rows": total_rows,
                "channels": channels,
                "time_range": time_range,
                "is_large_file": False
            }
    
    def set_multi_channel_mode(self, enabled: bool):
        """设置多通道模式"""
        self.multi_channel_mode = enabled
    
    def get_multi_channel_mode(self) -> bool:
        """获取当前是否为多通道模式"""
        return self.multi_channel_mode
    
    def set_channel_name(self, channel_id: str, display_name: str):
        """设置通道显示名称"""
        self.channel_names[channel_id] = display_name
    
    def get_channel_names(self) -> Dict[str, str]:
        """获取所有通道名称映射"""
        return self.channel_names
    
    def set_channel_offset(self, channel_id: str, offset: float):
        """设置单个通道的偏移量"""
        self.channel_offsets[channel_id] = offset
    
    def get_channel_offsets(self) -> Dict[str, float]:
        """获取所有通道偏移量"""
        return self.channel_offsets
    
    def set_channel_cut_range(self, channel_id: str, start: int, end: int):
        """设置单个通道的切割范围"""
        self.channel_cut_ranges[channel_id] = [start, end]
    
    def get_channel_cut_ranges(self) -> Dict[str, List[int]]:
        """获取所有通道切割范围"""
        return self.channel_cut_ranges
    
    def get_channel_list(self, dataset_id: Optional[str] = None) -> List[str]:
        """获取所有通道ID列表"""
        if self.multi_channel_mode:
            dataset = self._resolve_dataset(dataset_id)
            if not dataset:
                return []
            return dataset.get("channels", [])
        if self.is_large_file:
            return self.metadata.get("channels", [])
        return list(self.data.keys())
        
    def clear_data(self):
        """清空所有已加载的数据和文件记录"""
        self.data = {}
        self.file_list = []
        self.channel_names = {}
        self.channel_offsets = {}
        self.channel_cut_ranges = {}
        self.large_file_handler = None
        self.is_large_file = False
        self.metadata = {}
        # 多通道数据集清空
        self.multi_channel_datasets = {}
        self.multi_channel_order = []
        return True
    
    def get_data(self):
        """获取全量数据（仅适用于小文件）"""
        return self.data
