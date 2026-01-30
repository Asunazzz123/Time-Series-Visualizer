import csv
from pathlib import Path
from typing import Dict, List, Optional


class TimeSeriesData:
    def __init__(self, filename: str, series_prefix: Optional[str] = None):
        self.filename = filename
        self.series_prefix = series_prefix or Path(filename).stem
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
                if name.lower() in {"time", "t", "timestamp"}:
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
                series_name = f"{self.series_prefix}:{col_name}"
                data[series_name]["x"].append(x_value)
                data[series_name]["y"].append(float(row[col_idx]))

        return data

    def get_data(self):
        return self.data
    
class MultiSeriesData:
    def __init__(self, file_list: List[str]):
        self.file_list = file_list
        self.data: Dict[str, Dict[str, List[float]]] = {}
        for file in file_list:
            ts_data = TimeSeriesData(file)
            self.data.update(ts_data.get_data())

    def get_data(self):
        return self.data
    # data.py



class MultiSeriesData:
    def __init__(self, file_list: List[str]):
        self.file_list = file_list
        self.data: Dict[str, Dict[str, List[float]]] = {}
        # 初始化时加载已有文件
        for file in file_list:
            self.add_file(file) # 重构：调用 add_file 方法

    def add_file(self, filepath: str):
        """动态添加单个文件的数据"""
        try:
            ts_data = TimeSeriesData(filepath)
            new_data = ts_data.get_data()
            if new_data:
                self.data.update(new_data)
                # 可选：如果希望记录文件列表
                if filepath not in self.file_list:
                    self.file_list.append(filepath)
            return True
        except Exception as e:
            print(f"Error loading {filepath}: {e}")
            return False
    def clear_data(self):
        """清空所有已加载的数据和文件记录"""
        self.data = {}
        self.file_list = []
        return True
    
    def get_data(self):
        return self.data
