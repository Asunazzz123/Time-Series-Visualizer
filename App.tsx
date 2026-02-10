import React, { useState, useEffect, useMemo, useRef } from 'react';
import Plot from 'react-plotly.js';
import axios from 'axios';
import type { PlotRelayoutEvent, Layout, Data } from 'plotly.js';

// 【方案3】使用 TypedArray 定义接口，大幅降低内存占用
interface SeriesData {
  x: Float32Array;
  y: Float32Array;
}

interface ChartData {
  [key: string]: SeriesData;
}

// 【Feature 1】分组类型定义 - 动态分组
interface GroupInfo {
  name: string;
  color: string;
}

interface GroupAssignment {
  [seriesName: string]: string; // 分组名称
}

// 【Feature 3】自动对齐偏移量
interface AutoOffsets {
  [seriesName: string]: number;
}

// 【Feature 2】切割范围
interface CutRange {
  start: number;
  end: number;
  enabled: boolean;
}

// 【多通道模式】通道命名映射
interface ChannelNames {
  [channelId: string]: string;
}

// 【多通道模式】通道偏移量
interface ChannelOffsets {
  [channelId: string]: number;
}

// 【多通道模式】通道切割范围
interface ChannelCutRanges {
  [channelId: string]: { start: number; end: number; enabled: boolean };
}

// 【多通道模式】数据集信息
interface MultiChannelDataset {
  id: string;
  name: string;
  filename: string;
  is_large_file: boolean;
  total_rows: number;
  time_range: [number, number];
  channels: string[];
  file_size_mb?: number;
}

// 预设颜色调色板（用于自动分配颜色）
const COLOR_PALETTE = [
  '#1f77b4',  // 蓝色
  '#d62728',  // 红色
  '#2ca02c',  // 绿色
  '#ff7f0e',  // 橙色
  '#9467bd',  // 紫色
  '#8c564b',  // 棕色
  '#e377c2',  // 粉色
  '#7f7f7f',  // 灰色
  '#bcbd22',  // 黄绿色
  '#17becf',  // 青色
];

// 生成随机颜色（当预设颜色用完时）
const generateRandomColor = (): string => {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 70%, 50%)`;
};

// 默认分组
const DEFAULT_GROUPS: GroupInfo[] = [
  { name: 'Normal', color: '#1f77b4' },
  { name: 'Abnormal', color: '#d62728' },
];

const TimeSeriesAnalyzer: React.FC = () => {
  const [rawData, setRawData] = useState<ChartData | null>(null);
  const [selectedSeries, setSelectedSeries] = useState<string>('');
  const [shiftAmount, setShiftAmount] = useState<number>(0);
  
  // 状态：当前可见的X轴范围
  const [visibleRange, setVisibleRange] = useState<[number, number] | null>(null);
  
  // 上传相关状态
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 【Feature 1】分组状态 - 动态分组列表
  const [groups, setGroups] = useState<GroupInfo[]>(DEFAULT_GROUPS);
  const [groupAssignment, setGroupAssignment] = useState<GroupAssignment>({});
  const [uploadGroup, setUploadGroup] = useState<string>('Normal');
  const [showGroupManager, setShowGroupManager] = useState(false);
  const [newGroupName, setNewGroupName] = useState<string>('');
  const [referenceGroup, setReferenceGroup] = useState<string>('Normal'); // 用于对齐的参考组

  // 【Feature 2】切割状态
  const [cutRange, setCutRange] = useState<CutRange>({ start: 0, end: 1000, enabled: false });

  // 【Feature 3】自动对齐偏移量
  const [autoOffsets, setAutoOffsets] = useState<AutoOffsets>({});
  const [isAligning, setIsAligning] = useState(false);

  // 【新增】整体移动分组功能
  const [isGroupShift, setIsGroupShift] = useState<boolean>(false);  // 是否整体移动分组
  const [selectedShiftGroup, setSelectedShiftGroup] = useState<string>('Normal');  // 选中要移动的分组
  const [groupShiftAmounts, setGroupShiftAmounts] = useState<Record<string, number>>({});  // 每个分组的手动偏移量

  // 【多通道模式】新增状态
  const [isMultiChannelMode, setIsMultiChannelMode] = useState<boolean>(false);  // 数据模式: false=单通道, true=多通道
  const [channelNames, setChannelNames] = useState<ChannelNames>({});  // 通道命名映射
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);  // 选中的通道列表
  const [showChannelManager, setShowChannelManager] = useState(false);  // 显示通道管理窗口
  const [channelOffsets, setChannelOffsets] = useState<ChannelOffsets>({});  // 每个通道的独立偏移
  const [channelCutRanges, setChannelCutRanges] = useState<ChannelCutRanges>({});  // 每个通道的独立切割范围
  const [channelAutoOffsets, setChannelAutoOffsets] = useState<AutoOffsets>({});  // 每个通道的自动对齐偏移

  // 【多通道模式】数据集管理状态
  const [multiChannelDatasets, setMultiChannelDatasets] = useState<MultiChannelDataset[]>([]);
  const [selectedDatasetIds, setSelectedDatasetIds] = useState<string[]>([]);
  const [showDatasetManager, setShowDatasetManager] = useState(false);
  const [rawDataByDataset, setRawDataByDataset] = useState<Record<string, ChartData>>({});
  const [channelDisplayDataByDataset, setChannelDisplayDataByDataset] = useState<Record<string, Record<string, { x: number[]; y: number[] }>>>({});
  const [isLoadingChannelByDataset, setIsLoadingChannelByDataset] = useState<Record<string, Record<string, boolean>>>({});
  const [datasetAutoOffsets, setDatasetAutoOffsets] = useState<Record<string, number>>({});
  const [datasetManualOffsets, setDatasetManualOffsets] = useState<Record<string, number>>({});
  const [isDatasetAligning, setIsDatasetAligning] = useState(false);
  const [referenceDatasetId, setReferenceDatasetId] = useState<string>('');
  const [selectedShiftDatasetId, setSelectedShiftDatasetId] = useState<string>('');
  const [isDatasetAlignEnabled, setIsDatasetAlignEnabled] = useState<boolean>(true);
  const [channelVisibleRanges, setChannelVisibleRanges] = useState<Record<string, [number, number] | null>>({});
  const [channelCutInputs, setChannelCutInputs] = useState<Record<string, { start: string; end: string }>>({});
  const [referenceLines, setReferenceLines] = useState<Array<{ id: string; x: number; color: string }>>([]);
  const TARGET_DISPLAY_POINTS = 10000;  // 每个通道显示的目标点数 (SVG模式下建议降低点数以提升性能)

  const datasetMap = useMemo(() => {
    const map: Record<string, MultiChannelDataset> = {};
    multiChannelDatasets.forEach(ds => {
      map[ds.id] = ds;
    });
    return map;
  }, [multiChannelDatasets]);

  const datasetIdsToShow = useMemo(() => {
    if (selectedDatasetIds.length > 0) return selectedDatasetIds;
    return multiChannelDatasets.map(ds => ds.id);
  }, [selectedDatasetIds, multiChannelDatasets]);

  const referenceLineShapes = useMemo(() => {
    return referenceLines.map(line => ({
      type: 'line',
      xref: 'x',
      yref: 'paper',
      x0: line.x,
      x1: line.x,
      y0: 0,
      y1: 1,
      line: { color: '#000000', width: 1, dash: 'solid' }
    }));
  }, [referenceLines]);

  const getDatasetColor = (datasetId: string): string => {
    const index = multiChannelDatasets.findIndex(ds => ds.id === datasetId);
    if (index < 0) return '#999999';
    return COLOR_PALETTE[index % COLOR_PALETTE.length];
  };

  const computeAllChannelsFromDatasets = (datasets: MultiChannelDataset[]): string[] => {
    const channelSet = new Set<string>();
    datasets.forEach(ds => {
      (ds.channels || []).forEach(ch => {
        if (ch.startsWith('AI2-')) {
          channelSet.add(ch);
        }
      });
    });
    return Array.from(channelSet).sort();
  };

  const findStartIndex = (arr: Float32Array, start: number): number => {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (arr[mid] < start) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  };

  const findEndIndex = (arr: Float32Array, end: number): number => {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (arr[mid] <= end) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  };

  const findStartIndexArray = (arr: number[], start: number): number => {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (arr[mid] < start) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  };

  const findEndIndexArray = (arr: number[], end: number): number => {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (arr[mid] <= end) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  };

  const updateReferenceLinesFromRelayout = (event: Record<string, any>) => {
    const updates: Record<number, number> = {};
    Object.keys(event).forEach(key => {
      const match = key.match(/^shapes\[(\d+)\]\.x0$/);
      if (match) {
        const idx = parseInt(match[1], 10);
        const val = Number(event[key]);
        if (Number.isFinite(val)) {
          updates[idx] = val;
        }
      }
    });
    if (Object.keys(updates).length === 0) {
      Object.keys(event).forEach(key => {
        const match = key.match(/^shapes\[(\d+)\]\.x1$/);
        if (match) {
          const idx = parseInt(match[1], 10);
          const val = Number(event[key]);
          if (Number.isFinite(val)) {
            updates[idx] = val;
          }
        }
      });
    }
    if (Object.keys(updates).length === 0) return;
    setReferenceLines(prev =>
      prev.map((line, idx) =>
        updates[idx] !== undefined ? { ...line, x: updates[idx] } : line
      )
    );
  };

  const ensureReferenceDataset = (datasets: MultiChannelDataset[], selectedIds: string[]) => {
    if (datasets.length === 0) {
      setReferenceDatasetId('');
      return;
    }
    const candidateIds = selectedIds.length > 0 ? selectedIds : datasets.map(ds => ds.id);
    if (candidateIds.length === 0) {
      setReferenceDatasetId('');
      return;
    }
    if (!referenceDatasetId || !candidateIds.includes(referenceDatasetId)) {
      setReferenceDatasetId(candidateIds[0]);
    }
  };

  // 1. 提取数据获取逻辑
  const fetchData = async () => {
    try {
      const res = await axios.get('http://localhost:8000/data');
      const processed: ChartData = {};
      
      // 数据预处理：将普通数组转为 Float32Array
      const keys = Object.keys(res.data);
      keys.forEach(key => {
        processed[key] = {
          x: new Float32Array(res.data[key].x),
          y: new Float32Array(res.data[key].y)
        }; 
      });
      
      setRawData(processed);

      // 【Feature 1】为新序列分配默认分组（使用当前选择的上传分组）
      setGroupAssignment(prev => {
        const updated = { ...prev };
        keys.forEach(key => {
          if (!(key in updated)) {
            // 默认归为当前选择的上传分组，如果没有则归为第一个分组
            updated[key] = uploadGroup || (groups.length > 0 ? groups[0].name : 'Normal');
          }
        });
        return updated;
      });

      // 【多通道模式】初始化通道名称和选择
      if (isMultiChannelMode && keys.length > 0) {
        // 检查是否为AI2-xx格式的通道
        const isMultiChannelData = keys.some(key => key.startsWith('AI2-'));
        if (isMultiChannelData) {
          // 初始化通道名称（如果还没有设置）
          setChannelNames(prev => {
            const updated = { ...prev };
            keys.forEach(key => {
              if (!(key in updated)) {
                updated[key] = key; // 默认使用通道ID作为名称
              }
            });
            return updated;
          });
          // 默认选中所有通道
          if (selectedChannels.length === 0) {
            setSelectedChannels(keys.filter(k => k.startsWith('AI2-')));
          }
        }
      }

      // 逻辑修正：如果当前没有选中序列，或者选中的序列不在新数据中，默认选中第一个
      if (keys.length > 0) {
        setSelectedSeries(prev => {
           if (prev && keys.includes(prev)) return prev;
           return keys[0];
        });
        
        // 【Feature 2】更新切割范围的最大值
        const firstKey = keys[0];
        if (processed[firstKey]) {
          setCutRange(prev => ({
            ...prev,
            end: Math.min(prev.end, processed[firstKey].x.length)
          }));
        }
      } else {
        // 如果后端返回空数据，重置选中项
        setSelectedSeries('');
      }
    } catch (err) {
      console.error("Fetch error:", err);
      // 【修复】网络错误时也设置为空对象，避免卡在加载界面
      if (!rawData) {
        setRawData({});
      }
    }
  };

  // 【多通道模式】获取数据集列表
  const fetchMultiChannelDatasets = async () => {
    try {
      const response = await axios.get('http://localhost:8000/multi-channel/datasets');
      const datasets: MultiChannelDataset[] = response.data.datasets || [];
      setMultiChannelDatasets(datasets);

      const datasetIds = datasets.map(ds => ds.id);
      setSelectedDatasetIds(prev => {
        if (prev.length === 0) return datasetIds;
        return prev.filter(id => datasetIds.includes(id));
      });

      const allChannels = computeAllChannelsFromDatasets(datasets);
      if (allChannels.length > 0) {
        setSelectedChannels(prev => {
          if (prev.length === 0) return allChannels;
          const merged = new Set([...prev, ...allChannels]);
          return Array.from(merged).sort();
        });
        setSelectedSeries(prev => {
          if (prev && allChannels.includes(prev)) return prev;
          return allChannels[0];
        });
        setChannelNames(prev => {
          const updated = { ...prev };
          allChannels.forEach(ch => {
            if (!(ch in updated)) updated[ch] = ch;
          });
          return updated;
        });
      }

      // 预加载各数据集
      await Promise.all(
        datasets.map(async (ds) => {
          if (ds.is_large_file) {
            if (!channelDisplayDataByDataset[ds.id]) {
              await loadChannelDataForDisplay(ds.id, ds.channels || allChannels);
            }
          } else {
            if (!rawDataByDataset[ds.id]) {
              await fetchMultiChannelDatasetData(ds.id);
            }
          }
        })
      );
    } catch (err) {
      console.error("Fetch multi-channel datasets error:", err);
    }
  };

  // 初始加载/模式切换加载
  useEffect(() => {
    if (isMultiChannelMode) {
      fetchMultiChannelDatasets();
    } else {
      // 单通道模式：初始化为空对象，避免卡在加载界面
      if (rawData === null) {
        setRawData({});
      }
      fetchData();
    }
  }, [isMultiChannelMode]);

  useEffect(() => {
    if (isMultiChannelMode) {
      ensureReferenceDataset(multiChannelDatasets, selectedDatasetIds);
    }
  }, [isMultiChannelMode, multiChannelDatasets, selectedDatasetIds]);

  useEffect(() => {
    if (!isMultiChannelMode) return;
    if (datasetIdsToShow.length === 0) {
      setSelectedShiftDatasetId('');
      return;
    }
    if (!selectedShiftDatasetId || !datasetIdsToShow.includes(selectedShiftDatasetId)) {
      setSelectedShiftDatasetId(datasetIdsToShow[0]);
    }
  }, [isMultiChannelMode, datasetIdsToShow, selectedShiftDatasetId]);

  useEffect(() => {
    if (!isMultiChannelMode || !selectedSeries) return;
    const cut = channelCutRanges[selectedSeries];
    const hasCut = !!cut?.enabled && Number.isFinite(cut.start) && Number.isFinite(cut.end);
    datasetIdsToShow.forEach(datasetId => {
      const ds = datasetMap[datasetId];
      if (!ds?.is_large_file) return;
      if (hasCut) {
        refreshChannelData(datasetId, selectedSeries, cut!.start, cut!.end);
      } else {
        refreshChannelData(datasetId, selectedSeries);
      }
    });
  }, [isMultiChannelMode, selectedSeries, channelCutRanges, datasetIdsToShow, datasetMap]);

  // 处理文件上传
  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    const formData = new FormData();
    formData.append('file', file);
    formData.append('multi_channel_mode', String(isMultiChannelMode));

    setIsUploading(true);
    try {
      const response = await axios.post('http://localhost:8000/upload', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
        // 大文件上传超时设置
        timeout: 600000,  // 10分钟超时
      });
      
      // 检查是否有格式错误
      if (response.data.error) {
        if (response.data.format_error) {
          alert(`文件格式错误: ${response.data.message}\n\n多通道模式要求CSV文件格式为: time[s], AI2-xx, AI2-yy, ... (通道数量可变，允许缺失)`);
        } else {
          alert(`上传失败: ${response.data.message}`);
        }
        return;
      }
      
      // 【Feature 1】上传后立即分配到指定分组（仅单通道模式）
      if (!isMultiChannelMode) {
        const seriesPrefix = file.name.replace('.csv', '');
        setGroupAssignment(prev => ({
          ...prev,
          [seriesPrefix]: uploadGroup
        }));
        alert(`文件 ${file.name} 上传成功！已分配到 ${uploadGroup} 组`);
        await fetchData();
      } else {
        // 【多通道模式】处理上传响应
        const dataset: MultiChannelDataset = response.data.dataset || {
          id: response.data.dataset_id || String(Date.now()),
          name: response.data.dataset_name || file.name.replace('.csv', ''),
          filename: file.name,
          is_large_file: response.data.is_large_file || false,
          total_rows: response.data.total_rows || 0,
          time_range: response.data.time_range || [0, 0],
          channels: response.data.channels || [],
          file_size_mb: response.data.file_size_mb || 0
        };

        setMultiChannelDatasets(prev => {
          const exists = prev.some(ds => ds.id === dataset.id);
          if (exists) {
            return prev.map(ds => ds.id === dataset.id ? dataset : ds);
          }
          return [...prev, dataset];
        });

        setSelectedDatasetIds(prev => prev.includes(dataset.id) ? prev : [...prev, dataset.id]);

        const channels = dataset.channels || [];
        if (channels.length > 0) {
          setSelectedChannels(prev => {
            if (prev.length === 0) return channels.slice().sort();
            const merged = new Set([...prev, ...channels]);
            return Array.from(merged).sort();
          });
          setSelectedSeries(prev => {
            if (prev && channels.includes(prev)) return prev;
            return channels[0];
          });
          setChannelNames(prev => {
            const updated = { ...prev };
            channels.forEach(ch => {
              if (!(ch in updated)) {
                updated[ch] = ch;
              }
            });
            return updated;
          });
        }

        const fileSizeMB = dataset.file_size_mb || 0;
        const totalRows = dataset.total_rows || 0;

        if (dataset.is_large_file) {
          alert(`大文件上传成功！\n数据集: ${dataset.name}\n文件大小: ${fileSizeMB} MB\n数据点数: ${totalRows.toLocaleString()}\n通道数: ${channels.length}\n\n已启用降采样模式，确保流畅显示。`);
          // 大文件模式：按需加载数据
          await loadChannelDataForDisplay(dataset.id, channels);
        } else {
          alert(`文件 ${file.name} 上传成功！已添加数据集: ${dataset.name}（${channels.length} 个通道）`);
          await fetchMultiChannelDatasetData(dataset.id);
        }
      }
    } catch (error) {
      console.error("Upload failed", error);
      alert("上传失败，请检查后端服务是否启动，或文件过大导致超时");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // 【多通道模式】加载单个数据集的通道数据（大文件降采样）
  const loadChannelDataForDisplay = async (datasetId: string, channels: string[]) => {
    const loadingState: Record<string, boolean> = {};
    channels.forEach(ch => { loadingState[ch] = true; });
    setIsLoadingChannelByDataset(prev => ({
      ...prev,
      [datasetId]: { ...(prev[datasetId] || {}), ...loadingState }
    }));
    
    const displayData: Record<string, { x: number[]; y: number[] }> = {};
    
    // 并行加载所有通道（使用降采样）
    await Promise.all(
      channels.map(async (channelId) => {
        try {
          const response = await axios.get(`http://localhost:8000/channel-data/${channelId}`, {
            params: { target_points: TARGET_DISPLAY_POINTS, dataset_id: datasetId }
          });
          
          if (response.data.data) {
            displayData[channelId] = {
              x: response.data.data.x,
              y: response.data.data.y
            };
          }
        } catch (err) {
          console.error(`Failed to load channel ${channelId} for dataset ${datasetId}:`, err);
          displayData[channelId] = { x: [], y: [] };
        } finally {
          setIsLoadingChannelByDataset(prev => ({
            ...prev,
            [datasetId]: { ...(prev[datasetId] || {}), [channelId]: false }
          }));
        }
      })
    );
    
    setChannelDisplayDataByDataset(prev => ({
      ...prev,
      [datasetId]: { ...(prev[datasetId] || {}), ...displayData }
    }));
  };

  // 【多通道模式】获取小文件数据集全量数据
  const fetchMultiChannelDatasetData = async (datasetId: string) => {
    try {
      const res = await axios.get(`http://localhost:8000/multi-channel/data/${datasetId}`);
      const data = res.data.data || {};
      const processed: ChartData = {};
      
      Object.keys(data).forEach(key => {
        processed[key] = {
          x: new Float32Array(data[key].x),
          y: new Float32Array(data[key].y)
        };
      });
      
      setRawDataByDataset(prev => ({
        ...prev,
        [datasetId]: processed
      }));
    } catch (err) {
      console.error(`Failed to load dataset ${datasetId}:`, err);
    }
  };

  // 【多通道模式】刷新单个通道的显示数据（用于视图范围变化时）
  const refreshChannelData = async (datasetId: string, channelId: string, startTime?: number, endTime?: number) => {
    const dataset = datasetMap[datasetId];
    if (!dataset?.is_large_file) return;
    
    setIsLoadingChannelByDataset(prev => ({
      ...prev,
      [datasetId]: { ...(prev[datasetId] || {}), [channelId]: true }
    }));
    
    try {
      let response;
      if (startTime !== undefined && endTime !== undefined) {
        response = await axios.get(`http://localhost:8000/channel-data-by-time/${channelId}`, {
          params: { 
            start_time: startTime, 
            end_time: endTime, 
            target_points: TARGET_DISPLAY_POINTS,
            dataset_id: datasetId
          }
        });
      } else {
        response = await axios.get(`http://localhost:8000/channel-data/${channelId}`, {
          params: { target_points: TARGET_DISPLAY_POINTS, dataset_id: datasetId }
        });
      }
      
      if (response.data.data) {
        setChannelDisplayDataByDataset(prev => ({
          ...prev,
          [datasetId]: {
            ...(prev[datasetId] || {}),
            [channelId]: {
              x: response.data.data.x,
              y: response.data.data.y
            }
          }
        }));
      }
    } catch (err) {
      console.error(`Failed to refresh channel ${channelId} for dataset ${datasetId}:`, err);
    } finally {
      setIsLoadingChannelByDataset(prev => ({
        ...prev,
        [datasetId]: { ...(prev[datasetId] || {}), [channelId]: false }
      }));
    }
  };

  // 【新增】处理清空数据
  const handleClearData = async () => {
    const noSingleData = !rawData || Object.keys(rawData).length === 0;
    const noMultiData = multiChannelDatasets.length === 0;
    if ((!isMultiChannelMode && noSingleData) || (isMultiChannelMode && noMultiData)) {
      return;
    }
    
    if (!window.confirm("确定要清空所有已加载的序列吗？这将重置图表并删除已上传的CSV文件。")) {
      return;
    }

    try {
      const response = await axios.post('http://localhost:8000/clear');
      // 清空本地状态
      setRawData({}); 
      setSelectedSeries('');
      setShiftAmount(0);
      setVisibleRange(null);
      setGroupAssignment({});
      setAutoOffsets({});
      setCutRange({ start: 0, end: 1000, enabled: false });
      // 【多通道模式】清空通道相关状态
      setChannelNames({});
      setSelectedChannels([]);
      setChannelOffsets({});
      setChannelCutRanges({});
      setChannelAutoOffsets({});
      // 【多通道模式】清空数据集状态
      setMultiChannelDatasets([]);
      setSelectedDatasetIds([]);
      setShowDatasetManager(false);
      setRawDataByDataset({});
      setChannelDisplayDataByDataset({});
      setIsLoadingChannelByDataset({});
      setDatasetAutoOffsets({});
      setDatasetManualOffsets({});
      setReferenceDatasetId('');
      setSelectedShiftDatasetId('');
      setIsDatasetAlignEnabled(true);
      setChannelVisibleRanges({});
      setChannelCutInputs({});
      setReferenceLines([]);
      
      // 显示删除信息
      const deletedCount = response.data.files_deleted_count || 0;
      if (deletedCount > 0) {
        alert(`所有数据已清空，已删除 ${deletedCount} 个CSV文件`);
      } else {
        alert("所有数据已清空");
      }
    } catch (error) {
      console.error("Clear failed", error);
      alert("清空失败，请检查后端连接");
    }
  };

  // 【多通道模式】获取所有通道列表
  const getAllChannels = (): string[] => {
    if (isMultiChannelMode) {
      const fromDatasets = computeAllChannelsFromDatasets(multiChannelDatasets);
      if (fromDatasets.length > 0) return fromDatasets;
    }
    // 单通道模式回退：从 rawData 获取
    if (rawData && Object.keys(rawData).length > 0) {
      return Object.keys(rawData).filter(key => key.startsWith('AI2-')).sort();
    }
    // 兜底：从 channelNames 获取
    if (Object.keys(channelNames).length > 0) {
      return Object.keys(channelNames).filter(ch => ch.startsWith('AI2-')).sort();
    }
    return [];
  };

  // 【多通道模式】处理通道选择变化
  const handleChannelSelectionChange = (channelId: string, selected: boolean) => {
    if (selected) {
      setSelectedChannels(prev => [...prev, channelId].sort());
    } else {
      setSelectedChannels(prev => prev.filter(ch => ch !== channelId));
    }
  };

  // 【多通道模式】全选/取消全选
  const handleSelectAllChannels = (selectAll: boolean) => {
    if (selectAll) {
      setSelectedChannels(getAllChannels());
    } else {
      setSelectedChannels([]);
    }
  };

  // 【多通道模式】更新通道名称
  const updateChannelName = (channelId: string, newName: string) => {
    setChannelNames(prev => ({
      ...prev,
      [channelId]: newName
    }));
  };

  // 【多通道模式】更新通道偏移量
  const updateChannelOffset = (channelId: string, offset: number) => {
    setChannelOffsets(prev => ({
      ...prev,
      [channelId]: offset
    }));
  };

  // 【多通道模式】更新通道切割范围
  const updateChannelCutRange = (channelId: string, start: number, end: number, enabled: boolean) => {
    setChannelCutRanges(prev => ({
      ...prev,
      [channelId]: { start, end, enabled }
    }));
  };

  // 【多通道模式】处理数据集选择变化
  const handleDatasetSelectionChange = (datasetId: string, selected: boolean) => {
    if (selected) {
      setSelectedDatasetIds(prev => [...prev, datasetId].filter((v, i, a) => a.indexOf(v) === i));
    } else {
      setSelectedDatasetIds(prev => prev.filter(id => id !== datasetId));
    }
  };

  // 【多通道模式】全选/取消全选数据集
  const handleSelectAllDatasets = (selectAll: boolean) => {
    if (selectAll) {
      setSelectedDatasetIds(multiChannelDatasets.map(ds => ds.id));
    } else {
      setSelectedDatasetIds([]);
    }
  };

  // 【多通道模式】更新数据集名称
  const updateDatasetName = async (datasetId: string, newName: string) => {
    setMultiChannelDatasets(prev => prev.map(ds => ds.id === datasetId ? { ...ds, name: newName } : ds));
    try {
      await axios.post('http://localhost:8000/multi-channel/dataset-name', {
        dataset_id: datasetId,
        name: newName
      });
    } catch (err) {
      console.error(`Failed to update dataset name ${datasetId}:`, err);
    }
  };

  // 【多通道模式】自动对齐数据集（基于选择通道）
  const handleAutoAlignDatasets = async () => {
    if (!selectedSeries) {
      alert('请先选择一个通道用于对齐');
      return;
    }
    const datasetIds = selectedDatasetIds.length > 0
      ? selectedDatasetIds
      : multiChannelDatasets.map(ds => ds.id);
    if (datasetIds.length < 2) {
      alert('请至少选择两个数据集进行对齐');
      return;
    }

    const referenceId = referenceDatasetId && datasetIds.includes(referenceDatasetId)
      ? referenceDatasetId
      : datasetIds[0];

    const cut = channelCutRanges[selectedSeries];
    const cutRange = (cut?.enabled && Number.isFinite(cut.start) && Number.isFinite(cut.end)) ? [cut.start, cut.end] : null;

    setIsDatasetAligning(true);
    try {
      const response = await axios.post('http://localhost:8000/multi-channel/align-datasets', {
        dataset_ids: datasetIds,
        channel_id: selectedSeries,
        reference_dataset_id: referenceId,
        cut_range: cutRange,
        target_points: TARGET_DISPLAY_POINTS
      });

      if (response.data.offsets) {
        setDatasetAutoOffsets(response.data.offsets);
      } else if (response.data.error) {
        alert(`对齐失败: ${response.data.error}`);
      }
    } catch (err) {
      console.error('Dataset alignment failed', err);
      alert('对齐失败，请检查后端服务');
    } finally {
      setIsDatasetAligning(false);
    }
  };

  const clearDatasetAutoOffsets = () => {
    setDatasetAutoOffsets({});
  };

  const addReferenceLine = () => {
    const range = isMultiChannelMode
      ? (selectedSeries ? (channelVisibleRanges[selectedSeries] ?? dataRange) : dataRange)
      : (visibleRange ?? dataRange);
    const defaultX = range ? (range[0] + range[1]) / 2 : 0;
    setReferenceLines(prev => [
      ...prev,
      { id: `${Date.now()}-${prev.length}`, x: defaultX, color: '#000000' }
    ]);
  };

  // 【Feature 1】移动序列到指定分组
  const moveSeriesTo = (seriesName: string, targetGroup: string) => {
    setGroupAssignment(prev => ({
      ...prev,
      [seriesName]: targetGroup
    }));
  };

  // 【Feature 1】按分组获取序列列表
  const getSeriesByGroup = (groupName: string): string[] => {
    if (!rawData) return [];
    return Object.keys(rawData).filter(name => groupAssignment[name] === groupName);
  };

  // 【Feature 1】获取分组颜色
  const getGroupColor = (groupName: string): string => {
    const group = groups.find(g => g.name === groupName);
    return group?.color || '#999999';
  };

  // 【Feature 1】添加新分组
  const addNewGroup = () => {
    const trimmedName = newGroupName.trim();
    if (!trimmedName) {
      alert('请输入分组名称');
      return;
    }
    if (groups.some(g => g.name === trimmedName)) {
      alert('该分组名称已存在');
      return;
    }
    
    // 自动分配颜色
    const usedColors = groups.map(g => g.color);
    let newColor = COLOR_PALETTE.find(c => !usedColors.includes(c));
    if (!newColor) {
      newColor = generateRandomColor();
    }
    
    setGroups(prev => [...prev, { name: trimmedName, color: newColor! }]);
    setNewGroupName('');
  };

  // 【Feature 1】删除分组（将该分组的序列移到第一个分组）
  const deleteGroup = (groupName: string) => {
    if (groups.length <= 1) {
      alert('至少需要保留一个分组');
      return;
    }
    
    const firstGroup = groups.find(g => g.name !== groupName)?.name || 'Normal';
    
    // 将该分组的序列移到第一个分组
    setGroupAssignment(prev => {
      const updated = { ...prev };
      Object.keys(updated).forEach(key => {
        if (updated[key] === groupName) {
          updated[key] = firstGroup;
        }
      });
      return updated;
    });
    
    setGroups(prev => prev.filter(g => g.name !== groupName));
    
    // 如果删除的是当前上传分组或参考分组，切换到第一个分组
    if (uploadGroup === groupName) setUploadGroup(firstGroup);
    if (referenceGroup === groupName) setReferenceGroup(firstGroup);
  };

  // 【Feature 3】自动对齐处理
  const handleAutoAlign = async () => {
    if (!rawData || Object.keys(rawData).length === 0) return;

    setIsAligning(true);
    try {
      // 构建所有分组信息
      const groupsData: Record<string, string[]> = {};
      groups.forEach(g => {
        groupsData[g.name] = getSeriesByGroup(g.name);
      });

      // 构建切割范围信息
      const cutRanges: Record<string, number[]> | undefined = cutRange.enabled
        ? Object.keys(rawData).reduce((acc, name) => {
            acc[name] = [cutRange.start, cutRange.end];
            return acc;
          }, {} as Record<string, number[]>)
        : undefined;

      const response = await axios.post('http://localhost:8000/align', {
        groups: groupsData,
        cut_ranges: cutRanges,
        reference_group: referenceGroup  // 使用用户选择的参考组
      });

      if (response.data.offsets) {
        setAutoOffsets(response.data.offsets);
        alert('自动对齐完成！');
      } else if (response.data.error) {
        alert(`对齐失败: ${response.data.error}`);
      }
    } catch (error) {
      console.error("Alignment failed", error);
      alert("对齐失败，请检查后端服务");
    } finally {
      setIsAligning(false);
    }
  };

  // 【Feature 3】清除自动对齐
  const clearAutoOffsets = () => {
    setAutoOffsets({});
  };

  // 2. 计算用于渲染的数据（核心性能优化区）
  // 【更新】整合 Feature 1-3: 分组颜色 + 切割 + 自动对齐 + 手动平移
  const plotData = useMemo(() => {
    if (!rawData || isMultiChannelMode) return [];

    // 【单通道模式】原有逻辑
    return Object.keys(rawData).map((seriesName) => {
      const series = rawData[seriesName];
      
      // 【Feature 2】确定有效数据范围（切割）
      const start = cutRange.enabled ? Math.max(0, cutRange.start) : 0;
      const end = cutRange.enabled ? Math.min(series.x.length, cutRange.end) : series.x.length;
      
      // 获取切割后的数据
      const effectiveX = series.x.subarray(start, end);
      const effectiveY = series.y.subarray(start, end);
      
      // 【Feature 3】获取自动对齐偏移量
      const autoOffset = autoOffsets[seriesName] || 0;
      
      // 【Feature 2 & 3】计算最终的 X 轴数据
      // Final_X = (Raw_X[start:end]) + Auto_Offset + Manual_Shift
      // 手动偏移：根据是否整体移动，使用单序列偏移或分组偏移
      const seriesGroup = groupAssignment[seriesName] || (groups.length > 0 ? groups[0].name : 'Normal');
      let manualShift = 0;
      if (isGroupShift) {
        // 整体移动模式：使用分组偏移量
        manualShift = groupShiftAmounts[seriesGroup] || 0;
      } else {
        // 单序列模式：仅选中的序列移动
        manualShift = seriesName === selectedSeries ? shiftAmount : 0;
      }
      const totalOffset = autoOffset + manualShift;
      
      let currentX: Float32Array;
      if (totalOffset !== 0) {
        const len = effectiveX.length;
        const shifted = new Float32Array(len);
        for (let i = 0; i < len; i++) {
          shifted[i] = effectiveX[i] + totalOffset;
        }
        currentX = shifted;
      } else {
        currentX = effectiveX;
      }

      // 【Feature 1】根据分组设置颜色（动态获取）
      const group = groupAssignment[seriesName] || (groups.length > 0 ? groups[0].name : 'Normal');
      const color = getGroupColor(group);

      return {
        name: `${seriesName} [${group}]`,
        x: currentX, 
        y: effectiveY,
        type: 'scatter', 
        mode: 'lines',
        line: { width: 1.5, color } 
      } as Data;
    });
  }, [rawData, selectedSeries, shiftAmount, groupAssignment, autoOffsets, cutRange, groups, isGroupShift, groupShiftAmounts, selectedShiftGroup, isMultiChannelMode]);

  // 计算数据的绝对范围
  const dataRange = useMemo<[number, number] | null>(() => {
    if (!selectedSeries) return null;

    if (isMultiChannelMode) {
      const datasetId = selectedDatasetIds[0] || multiChannelDatasets[0]?.id;
      if (!datasetId) return null;
      const dataset = datasetMap[datasetId];
      if (dataset?.is_large_file) {
        return dataset.time_range || [0, 100];
      }
      const series = rawDataByDataset[datasetId]?.[selectedSeries];
      if (!series || series.x.length === 0) return null;

      let min = Infinity;
      let max = -Infinity;
      const len = series.x.length;
      for (let i = 0; i < len; i++) {
        const val = series.x[i];
        if (val < min) min = val;
        if (val > max) max = val;
      }
      if (min === Infinity) return [0, 100];
      return [min, max];
    }

    if (!rawData) return null;
    const series = rawData[selectedSeries];
    if (!series || series.x.length === 0) return null;
    
    let min = Infinity;
    let max = -Infinity;
    const len = series.x.length;
    for (let i = 0; i < len; i++) {
      const val = series.x[i];
      if (val < min) min = val;
      if (val > max) max = val;
    }
    
    if (min === Infinity) return [0, 100];
    return [min, max];
  }, [isMultiChannelMode, multiChannelDatasets, selectedDatasetIds, datasetMap, rawDataByDataset, rawData, selectedSeries]);

  const effectiveRange = visibleRange ?? dataRange;
  const primaryDataset = selectedDatasetIds.length > 0
    ? datasetMap[selectedDatasetIds[0]]
    : (multiChannelDatasets.length > 0 ? datasetMap[multiChannelDatasets[0].id] : undefined);

  // 计算步长
  const shiftStep = useMemo(() => {
    if (!effectiveRange) return isMultiChannelMode ? 0.01 : 1;
    const length = Math.abs(effectiveRange[1] - effectiveRange[0]);
    if (isMultiChannelMode) {
      const rawStep = length === 0 ? 0.01 : length * 0.001;
      return Math.max(0.001, rawStep);
    }
    const rawStep = length === 0 ? 1 : length * 0.01;
    return Math.max(1, Math.ceil(rawStep));
  }, [effectiveRange, isMultiChannelMode]);

  // 计算平移限制
  const shiftLimits = useMemo(() => {
    if (!effectiveRange) {
      return isMultiChannelMode ? { min: -1, max: 1 } : { min: -1000, max: 1000 };
    }
    const length = Math.abs(effectiveRange[1] - effectiveRange[0]);
    if (isMultiChannelMode) {
      const limit = Math.max(0.1, length * 1.5);
      return { min: -limit, max: limit };
    }
    const limit = Math.max(1000, length * 1.5);
    return { min: -limit, max: limit };
  }, [effectiveRange, isMultiChannelMode]);

  const handleRelayout = (event: PlotRelayoutEvent) => {
    const e = event as Record<string, any>;
    updateReferenceLinesFromRelayout(e);
    const x0 = e['xaxis.range[0]'];
    const x1 = e['xaxis.range[1]'];
    const autorange = e['xaxis.autorange'];

    if (x0 !== undefined && x1 !== undefined) {
      setVisibleRange([Number(x0), Number(x1)]);
    } else if (autorange === true || e['xaxis.autorange'] === true) {
      setVisibleRange(null);
    }
  };

  const handleChannelRelayout = (channelId: string, event: PlotRelayoutEvent) => {
    const e = event as Record<string, any>;
    updateReferenceLinesFromRelayout(e);
    const x0 = e['xaxis.range[0]'];
    const x1 = e['xaxis.range[1]'];
    const autorange = e['xaxis.autorange'];

    if (x0 !== undefined && x1 !== undefined) {
      setChannelVisibleRanges(prev => ({
        ...prev,
        [channelId]: [Number(x0), Number(x1)]
      }));
    } else if (autorange === true || e['xaxis.autorange'] === true) {
      setChannelVisibleRanges(prev => ({
        ...prev,
        [channelId]: null
      }));
    }
  };

  const chartLayout = useMemo<Partial<Layout>>(() => {
    return {
      autosize: true,
      height: 500,
      title: { text: '多序列时序对比工具' },
      xaxis: { 
        title: { text: 'Time / Index' },
        range: visibleRange ? visibleRange : undefined,
      },
      yaxis: { title: { text: 'Value' } },
      hovermode: 'closest',
      uirevision: 'true', 
      shapes: referenceLineShapes,
    };
  }, [visibleRange, referenceLineShapes]);

  // 判断是否有数据（支持大文件模式和多通道模式）
  const hasData = (!isMultiChannelMode && rawData && Object.keys(rawData).length > 0) ||
                  (isMultiChannelMode && multiChannelDatasets.length > 0);

  // 加载中状态（仅在初始化且无数据时显示）
  if (!isMultiChannelMode && rawData === null && !isUploading) {
    return (
      <div style={{ 
        padding: '50px', 
        textAlign: 'center', 
        fontSize: '18px',
        color: '#666'
      }}>
        <div>正在加载数据...</div>
        <div style={{ marginTop: '10px', fontSize: '14px', color: '#999' }}>
          如果长时间未响应，请检查后端服务是否启动
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif', width: '100%', boxSizing: 'border-box' }}>
      
      {/* 顶部工具栏：标题与操作按钮 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2 style={{ margin: 0 }}>时序交互平移工具</h2>
        
        {/* 按钮区域 */}
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          {/* 【多通道模式】数据模式选择 */}
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '5px',
            padding: '5px 10px',
            backgroundColor: isMultiChannelMode ? '#e6f7ff' : '#f5f5f5',
            borderRadius: '4px',
            border: `1px solid ${isMultiChannelMode ? '#1890ff' : '#d9d9d9'}`
          }}>
            <label style={{ fontWeight: 'bold', fontSize: '12px' }}>数据模式:</label>
            <select
              value={isMultiChannelMode ? 'multi' : 'single'}
              onChange={(e) => {
                const isMulti = e.target.value === 'multi';
                setIsMultiChannelMode(isMulti);
                // 切换模式时清空数据
                if (hasData) {
                  if (window.confirm('切换数据模式将清空当前数据，是否继续？')) {
                    handleClearData();
                  }
                }
              }}
              style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid #ccc', fontSize: '12px' }}
            >
              <option value="single">单通道模式</option>
              <option value="multi">多通道模式</option>
            </select>
          </div>

          {/* 【Feature 1】上传分组选择 - 动态分组（仅单通道模式） */}
          {!isMultiChannelMode && (
            <select
              value={uploadGroup}
              onChange={(e) => setUploadGroup(e.target.value)}
              style={{ padding: '8px', borderRadius: '4px', border: '1px solid #ccc' }}
            >
              {groups.map(g => (
                <option key={g.name} value={g.name}>上传到: {g.name}</option>
              ))}
            </select>
          )}

          {/* 【新增】清空按钮 */}
          <button
            onClick={handleClearData}
            disabled={!hasData}
            style={{
              padding: '8px 16px',
              backgroundColor: '#ff4d4f', // 红色警告色
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: !hasData ? 'not-allowed' : 'pointer',
              fontWeight: 'bold',
              opacity: !hasData ? 0.6 : 1
            }}
          >
            🗑️ 清空序列
          </button>

          <input
            type="file"
            accept=".csv"
            onChange={handleFileUpload}
            style={{ display: 'none' }}
            ref={fileInputRef}
          />
          <button 
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            style={{ 
              padding: '8px 16px', 
              backgroundColor: isUploading ? '#ccc' : '#4CAF50', 
              color: 'white', 
              border: 'none', 
              borderRadius: '4px',
              cursor: isUploading ? 'not-allowed' : 'pointer',
              fontWeight: 'bold'
            }}
          >
            {isUploading ? '正在上传...' : '📂 上传 CSV 文件'}
          </button>

          {/* 【多通道模式】数据集管理按钮 */}
          {isMultiChannelMode && (
            <button
              onClick={() => setShowDatasetManager(!showDatasetManager)}
              disabled={!hasData}
              style={{
                padding: '8px 16px',
                backgroundColor: '#fa8c16',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: !hasData ? 'not-allowed' : 'pointer',
                fontWeight: 'bold',
                opacity: !hasData ? 0.6 : 1
              }}
            >
              🧾 数据集管理
            </button>
          )}

          {/* 【多通道模式】通道管理按钮 */}
          {isMultiChannelMode && (
            <button
              onClick={() => setShowChannelManager(!showChannelManager)}
              disabled={!hasData}
              style={{
                padding: '8px 16px',
                backgroundColor: '#13c2c2',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: !hasData ? 'not-allowed' : 'pointer',
                fontWeight: 'bold',
                opacity: !hasData ? 0.6 : 1
              }}
            >
              📡 通道管理
            </button>
          )}

          {/* 【Feature 1】分组管理按钮（仅单通道模式） */}
          {!isMultiChannelMode && (
            <button
              onClick={() => setShowGroupManager(!showGroupManager)}
              disabled={!hasData}
              style={{
                padding: '8px 16px',
                backgroundColor: '#722ed1',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: !hasData ? 'not-allowed' : 'pointer',
                fontWeight: 'bold',
                opacity: !hasData ? 0.6 : 1
              }}
            >
              📋 分组管理
            </button>
          )}
        </div>
      </div>

      {/* 【多通道模式】数据集管理面板 */}
      {isMultiChannelMode && showDatasetManager && hasData && (
        <div style={{ 
          marginBottom: '20px', 
          padding: '15px', 
          backgroundColor: '#fff7e6', 
          borderRadius: '8px',
          border: '1px solid #ffd591'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
            <h4 style={{ margin: 0 }}>🧾 数据集管理</h4>
            
            {/* 全选/取消全选 */}
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                onClick={() => handleSelectAllDatasets(true)}
                style={{
                  padding: '6px 12px',
                  backgroundColor: '#fa8c16',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '12px'
                }}
              >
                全选
              </button>
              <button
                onClick={() => handleSelectAllDatasets(false)}
                style={{
                  padding: '6px 12px',
                  backgroundColor: '#d9d9d9',
                  color: '#333',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '12px'
                }}
              >
                取消全选
              </button>
              <span style={{ fontSize: '12px', color: '#666' }}>
                已选择 {selectedDatasetIds.length} / {multiChannelDatasets.length} 个数据集
              </span>
            </div>
          </div>
          
          {/* 数据集列表 */}
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: multiChannelDatasets.length <= 1 ? 'repeat(1, 1fr)' : 'repeat(2, 1fr)', 
            gap: '10px',
            padding: '10px',
            backgroundColor: 'white',
            borderRadius: '6px',
            border: '1px solid #ffd591'
          }}>
            {multiChannelDatasets.length === 0 ? (
              <div style={{ color: '#999', fontSize: '12px' }}>暂无数据集</div>
            ) : (
              multiChannelDatasets.map((ds) => (
                <div 
                  key={ds.id}
                  style={{ 
                    display: 'flex', 
                    flexDirection: 'column',
                    gap: '6px',
                    padding: '8px',
                    backgroundColor: selectedDatasetIds.includes(ds.id) ? '#fffbe6' : '#fafafa',
                    borderRadius: '4px',
                    border: `1px solid ${selectedDatasetIds.includes(ds.id) ? '#fa8c16' : '#d9d9d9'}`
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <input
                      type="checkbox"
                      checked={selectedDatasetIds.includes(ds.id)}
                      onChange={(e) => handleDatasetSelectionChange(ds.id, e.target.checked)}
                    />
                    <span style={{ 
                      width: '10px', 
                      height: '10px', 
                      backgroundColor: getDatasetColor(ds.id),
                      borderRadius: '50%',
                      display: 'inline-block'
                    }} />
                    <span style={{ fontWeight: 'bold', fontSize: '11px' }}>
                      {ds.filename}
                    </span>
                    {ds.is_large_file && (
                      <span style={{ fontSize: '10px', color: '#fa8c16' }}>大文件</span>
                    )}
                  </div>
                  <input
                    type="text"
                    value={ds.name}
                    onChange={(e) => updateDatasetName(ds.id, e.target.value)}
                    placeholder="数据集名称"
                    style={{ 
                      padding: '4px 6px', 
                      fontSize: '11px', 
                      borderRadius: '3px', 
                      border: '1px solid #d9d9d9',
                      width: '100%',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* 【多通道模式】通道管理面板 */}
      {isMultiChannelMode && showChannelManager && hasData && (
        <div style={{ 
          marginBottom: '20px', 
          padding: '15px', 
          backgroundColor: '#e6fffb', 
          borderRadius: '8px',
          border: '1px solid #87e8de'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
            <h4 style={{ margin: 0 }}>📡 通道管理</h4>
            
            {/* 全选/取消全选 */}
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                onClick={() => handleSelectAllChannels(true)}
                style={{
                  padding: '6px 12px',
                  backgroundColor: '#1890ff',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '12px'
                }}
              >
                全选
              </button>
              <button
                onClick={() => handleSelectAllChannels(false)}
                style={{
                  padding: '6px 12px',
                  backgroundColor: '#d9d9d9',
                  color: '#333',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '12px'
                }}
              >
                取消全选
              </button>
              <span style={{ fontSize: '12px', color: '#666' }}>
                已选择 {selectedChannels.length} / {getAllChannels().length} 个通道
              </span>
            </div>
          </div>
          
          {/* 通道选择与命名 */}
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: 'repeat(4, 1fr)', 
            gap: '10px',
            maxHeight: '300px',
            overflowY: 'auto',
            padding: '10px',
            backgroundColor: 'white',
            borderRadius: '6px',
            border: '1px solid #d9d9d9'
          }}>
            {getAllChannels().map((channelId, index) => (
              <div 
                key={channelId} 
                style={{ 
                  display: 'flex', 
                  flexDirection: 'column',
                  gap: '4px',
                  padding: '8px',
                  backgroundColor: selectedChannels.includes(channelId) ? '#e6f7ff' : '#fafafa',
                  borderRadius: '4px',
                  border: `1px solid ${selectedChannels.includes(channelId) ? '#1890ff' : '#d9d9d9'}`
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <input
                    type="checkbox"
                    checked={selectedChannels.includes(channelId)}
                    onChange={(e) => handleChannelSelectionChange(channelId, e.target.checked)}
                  />
                  <span style={{ 
                    fontWeight: 'bold', 
                    fontSize: '11px',
                    color: COLOR_PALETTE[index % COLOR_PALETTE.length]
                  }}>
                    {channelId}
                  </span>
                </div>
                <input
                  type="text"
                  value={channelNames[channelId] || channelId}
                  onChange={(e) => updateChannelName(channelId, e.target.value)}
                  placeholder="通道别名"
                  style={{ 
                    padding: '4px 6px', 
                    fontSize: '11px', 
                    borderRadius: '3px', 
                    border: '1px solid #d9d9d9',
                    width: '100%',
                    boxSizing: 'border-box'
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 【Feature 1】分组管理面板 - 动态分组（仅单通道模式） */}
      {!isMultiChannelMode && showGroupManager && hasData && (
        <div style={{ 
          marginBottom: '20px', 
          padding: '15px', 
          backgroundColor: '#f0f0f0', 
          borderRadius: '8px',
          border: '1px solid #d9d9d9'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
            <h4 style={{ margin: 0 }}>📊 序列分组管理</h4>
            
            {/* 添加新分组 */}
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                type="text"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="新分组名称（如：跳料异常）"
                style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid #ccc', width: '180px' }}
                onKeyDown={(e) => e.key === 'Enter' && addNewGroup()}
              />
              <button
                onClick={addNewGroup}
                style={{
                  padding: '6px 12px',
                  backgroundColor: '#52c41a',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontWeight: 'bold'
                }}
              >
                ➕ 添加分组
              </button>
            </div>
          </div>
          
          {/* 动态分组列表 */}
          <div style={{ display: 'flex', gap: '15px', flexWrap: 'wrap' }}>
            {groups.map((group) => (
              <div key={group.name} style={{ 
                flex: '1 1 200px', 
                minWidth: '200px',
                maxWidth: '300px',
                backgroundColor: 'white',
                borderRadius: '6px',
                border: `2px solid ${group.color}`,
                overflow: 'hidden'
              }}>
                {/* 分组标题 */}
                <div style={{ 
                  display: 'flex', 
                  justifyContent: 'space-between', 
                  alignItems: 'center',
                  padding: '8px 10px',
                  backgroundColor: group.color,
                  color: 'white'
                }}>
                  <span style={{ fontWeight: 'bold' }}>
                    {group.name} ({getSeriesByGroup(group.name).length})
                  </span>
                  {groups.length > 1 && (
                    <button
                      onClick={() => deleteGroup(group.name)}
                      style={{
                        padding: '2px 6px',
                        fontSize: '11px',
                        backgroundColor: 'rgba(255,255,255,0.3)',
                        color: 'white',
                        border: 'none',
                        borderRadius: '3px',
                        cursor: 'pointer'
                      }}
                      title="删除分组"
                    >
                      ✕
                    </button>
                  )}
                </div>
                
                {/* 分组内序列 */}
                <div style={{ maxHeight: '150px', overflowY: 'auto', padding: '8px' }}>
                  {getSeriesByGroup(group.name).length === 0 ? (
                    <div style={{ color: '#999', fontSize: '12px', textAlign: 'center', padding: '10px' }}>
                      暂无序列
                    </div>
                  ) : (
                    getSeriesByGroup(group.name).map(name => (
                      <div key={name} style={{ 
                        display: 'flex', 
                        justifyContent: 'space-between', 
                        alignItems: 'center',
                        padding: '4px 6px',
                        backgroundColor: '#fafafa',
                        marginBottom: '4px',
                        borderRadius: '4px',
                        fontSize: '11px'
                      }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100px' }} title={name}>
                          {name}
                        </span>
                        {/* 移动到其他分组 */}
                        <select
                          value={group.name}
                          onChange={(e) => moveSeriesTo(name, e.target.value)}
                          style={{ 
                            padding: '2px 4px', 
                            fontSize: '10px',
                            borderRadius: '3px',
                            border: '1px solid #d9d9d9',
                            cursor: 'pointer'
                          }}
                        >
                          {groups.map(g => (
                            <option key={g.name} value={g.name}>→ {g.name}</option>
                          ))}
                        </select>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      
      {/* 控制面板：有数据时显示控件，无数据时显示提示 */}
      {hasData ? (
        <>
          {/* 【多通道模式】控制面板 */}
          {isMultiChannelMode ? (
            <div style={{ marginBottom: '15px', display: 'flex', gap: '20px', alignItems: 'center', flexWrap: 'wrap', backgroundColor: '#e6fffb', padding: '15px', borderRadius: '8px', border: '1px solid #87e8de' }}>
              {/* 选择要操作的通道 */}
              <div>
                <label style={{ marginRight: '8px', fontWeight: 'bold' }}>选择通道: </label>
                <select 
                  value={selectedSeries} 
                  onChange={(e) => {
                    setSelectedSeries(e.target.value);
                  }}
                  style={{ padding: '5px', minWidth: '150px' }}
                >
                  {getAllChannels().map(channelId => (
                    <option key={channelId} value={channelId}>
                      {channelNames[channelId] || channelId}
                    </option>
                  ))}
                </select>
              </div>

              {/* 数据集时间平移 */}
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', flex: 1, minWidth: '300px' }}>
                <label style={{ marginRight: '8px', fontWeight: 'bold' }}>数据集时间平移:</label>
                <select
                  value={selectedShiftDatasetId || ''}
                  onChange={(e) => setSelectedShiftDatasetId(e.target.value)}
                  style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid #87e8de', minWidth: '180px' }}
                >
                  {datasetIdsToShow.map(datasetId => {
                    const ds = datasetMap[datasetId];
                    if (!ds) return null;
                    return (
                      <option key={datasetId} value={datasetId}>
                        {ds.name || ds.filename || datasetId}
                      </option>
                    );
                  })}
                </select>
                <input 
                  type="range" 
                  min={shiftLimits.min}
                  max={shiftLimits.max}
                  step={shiftStep}
                  value={datasetManualOffsets[selectedShiftDatasetId] || 0}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setDatasetManualOffsets(prev => ({
                      ...prev,
                      [selectedShiftDatasetId]: val
                    }));
                  }}
                  style={{ width: '40%', verticalAlign: 'middle' }}
                  disabled={!selectedShiftDatasetId}
                />
                <span style={{ fontFamily: 'monospace' }}>
                  {(datasetManualOffsets[selectedShiftDatasetId] || 0).toFixed(4)}
                </span>
              </div>

              <button 
                onClick={() => {
                  setDatasetManualOffsets({});
                  setVisibleRange(null);
                }}
                style={{ padding: '5px 15px', cursor: 'pointer' }}
              >
                重置视图
              </button>
            </div>
          ) : (
            /* 【单通道模式】原有控制面板 */
            <div style={{ marginBottom: '15px', display: 'flex', gap: '20px', alignItems: 'center', flexWrap: 'wrap', backgroundColor: '#f9f9f9', padding: '15px', borderRadius: '8px', border: '1px solid #eee' }}>
              {/* 整体移动开关 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                <input
                  type="checkbox"
                  id="groupShiftToggle"
                  checked={isGroupShift}
                  onChange={(e) => {
                    setIsGroupShift(e.target.checked);
                    // 切换时重置偏移量
                    if (e.target.checked) {
                      setGroupShiftAmounts({});
                    } else {
                      setShiftAmount(0);
                    }
                  }}
                />
                <label htmlFor="groupShiftToggle" style={{ fontWeight: 'bold', cursor: 'pointer' }}>
                  整体移动
                </label>
              </div>

              {/* 根据模式显示不同的选择器 */}
              {isGroupShift ? (
                // 分组选择模式
                <div>
                  <label style={{ marginRight: '8px', fontWeight: 'bold' }}>选择分组: </label>
                  <select 
                    value={selectedShiftGroup} 
                    onChange={(e) => {
                      setSelectedShiftGroup(e.target.value);
                    }}
                    style={{ padding: '5px', minWidth: '150px' }}
                  >
                    {groups.map(g => (
                      <option key={g.name} value={g.name}>
                        {g.name} ({getSeriesByGroup(g.name).length}个序列)
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                // 单序列选择模式
                <div>
                  <label style={{ marginRight: '8px', fontWeight: 'bold' }}>选择序列: </label>
                  <select 
                    value={selectedSeries} 
                    onChange={(e) => {
                      setSelectedSeries(e.target.value);
                      setShiftAmount(0); 
                    }}
                    style={{ padding: '5px', minWidth: '150px' }}
                  >
                    {Object.keys(rawData!).map(key => (
                      <option key={key} value={key}>{key} [{groupAssignment[key] || 'Normal'}]</option>
                    ))}
                  </select>
                </div>
              )}

              <div style={{ flex: 1, minWidth: '300px' }}>
                <label style={{ marginRight: '8px', fontWeight: 'bold' }}>
                  X轴平移{isGroupShift ? ` (${selectedShiftGroup}组)` : ''}: 
                </label>
                <input 
                  type="range" 
                  min={Math.floor(shiftLimits.min)}
                  max={Math.ceil(shiftLimits.max)}
                  step={shiftStep}
                  value={isGroupShift ? (groupShiftAmounts[selectedShiftGroup] || 0) : shiftAmount}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    if (isGroupShift) {
                      setGroupShiftAmounts(prev => ({
                        ...prev,
                        [selectedShiftGroup]: val
                      }));
                    } else {
                      setShiftAmount(val);
                    }
                  }}
                  style={{ width: '60%', verticalAlign: 'middle' }}
                />
                <span style={{ marginLeft: '10px', fontFamily: 'monospace' }}>
                  {isGroupShift ? (groupShiftAmounts[selectedShiftGroup] || 0) : shiftAmount}
                </span>
              </div>

              <button 
                onClick={() => {
                  if (isGroupShift) {
                    setGroupShiftAmounts({});
                  } else {
                    setShiftAmount(0);
                  }
                  setVisibleRange(null);
                }}
                style={{ padding: '5px 15px', cursor: 'pointer' }}
              >
                重置视图
              </button>
            </div>
          )}

          {/* 【Feature 2 & 3】切割与对齐控制面板（仅单通道模式） */}
          {!isMultiChannelMode && (
            <div style={{ 
              marginBottom: '20px', 
              display: 'flex', 
              gap: '20px', 
              alignItems: 'center', 
              flexWrap: 'wrap', 
              backgroundColor: '#e6f7ff', 
              padding: '15px', 
              borderRadius: '8px', 
              border: '1px solid #91d5ff' 
            }}>
              {/* 【Feature 2】切割控制 */}
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <label style={{ fontWeight: 'bold' }}>✂️ 切割范围:</label>
                <label>
                  <input
                    type="checkbox"
                    checked={cutRange.enabled}
                    onChange={(e) => setCutRange(prev => ({ ...prev, enabled: e.target.checked }))}
                  />
                  启用
                </label>
                <input
                  type="number"
                  value={cutRange.start}
                  onChange={(e) => setCutRange(prev => ({ ...prev, start: Math.max(0, parseInt(e.target.value) || 0) }))}
                  disabled={!cutRange.enabled}
                  style={{ width: '80px', padding: '4px' }}
                  placeholder="起始"
                />
                <span>-</span>
                <input
                  type="number"
                  value={cutRange.end}
                  onChange={(e) => setCutRange(prev => ({ ...prev, end: parseInt(e.target.value) || 1000 }))}
                  disabled={!cutRange.enabled}
                  style={{ width: '80px', padding: '4px' }}
                  placeholder="结束"
                />
              </div>

              <div style={{ borderLeft: '1px solid #91d5ff', height: '30px' }} />

              {/* 【Feature 3】自动对齐控制 */}
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <label style={{ fontWeight: 'bold' }}>🎯 自动对齐:</label>
                
                {/* 参考组选择 */}
                <select
                  value={referenceGroup}
                  onChange={(e) => setReferenceGroup(e.target.value)}
                  style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid #91d5ff' }}
                  title="选择参考组（其他组将对齐到此组）"
                >
                  {groups.map(g => (
                    <option key={g.name} value={g.name}>参考: {g.name}</option>
                  ))}
                </select>
                
                <button
                  onClick={handleAutoAlign}
                  disabled={isAligning}
                  style={{
                    padding: '6px 16px',
                    backgroundColor: isAligning ? '#ccc' : '#1890ff',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: isAligning ? 'not-allowed' : 'pointer',
                    fontWeight: 'bold'
                  }}
                >
                  {isAligning ? '对齐中...' : '执行对齐'}
                </button>
                <button
                  onClick={clearAutoOffsets}
                  disabled={Object.keys(autoOffsets).length === 0}
                  style={{
                    padding: '6px 12px',
                    backgroundColor: Object.keys(autoOffsets).length === 0 ? '#ccc' : '#faad14',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: Object.keys(autoOffsets).length === 0 ? 'not-allowed' : 'pointer'
                  }}
                >
                  清除对齐
                </button>
                {Object.keys(autoOffsets).length > 0 && (
                  <span style={{ fontSize: '12px', color: '#52c41a' }}>
                    ✓ 已对齐 {Object.keys(autoOffsets).length} 个序列
                  </span>
                )}
              </div>
            </div>
          )}

          {/* 【多通道模式】通道切割控制面板 */}
          {isMultiChannelMode && selectedSeries && (
            <div style={{ 
              marginBottom: '20px', 
              display: 'flex', 
              gap: '20px', 
              alignItems: 'center', 
              flexWrap: 'wrap', 
              backgroundColor: '#e6fffb', 
              padding: '15px', 
              borderRadius: '8px', 
              border: '1px solid #87e8de' 
            }}>
              {/* 通道切割控制 */}
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ fontWeight: 'bold' }}>✂️ 通道切割 (时间) ({channelNames[selectedSeries] || selectedSeries}):</label>
                <label>
                  <input
                    type="checkbox"
                    checked={channelCutRanges[selectedSeries]?.enabled || false}
                    onChange={(e) => {
                      const current = channelCutRanges[selectedSeries];
                      if (current) {
                        updateChannelCutRange(selectedSeries, current.start, current.end, e.target.checked);
                      } else if (!e.target.checked) {
                        updateChannelCutRange(selectedSeries, 0, 0, false);
                      } else {
                        setChannelCutRanges(prev => ({
                          ...prev,
                          [selectedSeries]: { start: 0, end: 0, enabled: true }
                        }));
                      }
                    }}
                  />
                  启用
                </label>
                <input
                  type="number"
                  value={channelCutInputs[selectedSeries]?.start ?? ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    setChannelCutInputs(prev => ({
                      ...prev,
                      [selectedSeries]: { start: val, end: prev[selectedSeries]?.end ?? '' }
                    }));
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    const current = channelCutRanges[selectedSeries] || { start: 0, end: 0, enabled: false };
                    const startVal = parseFloat(channelCutInputs[selectedSeries]?.start ?? '');
                    if (!Number.isFinite(startVal)) return;
                    updateChannelCutRange(selectedSeries, Math.max(0, startVal), current.end, current.enabled);
                  }}
                  disabled={!channelCutRanges[selectedSeries]?.enabled}
                  style={{ width: '100px', padding: '4px' }}
                  placeholder="起始(s)"
                  step="0.001"
                />
                <span>-</span>
                <input
                  type="number"
                  value={channelCutInputs[selectedSeries]?.end ?? ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    setChannelCutInputs(prev => ({
                      ...prev,
                      [selectedSeries]: { start: prev[selectedSeries]?.start ?? '', end: val }
                    }));
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    const current = channelCutRanges[selectedSeries] || { start: 0, end: 0, enabled: false };
                    const endVal = parseFloat(channelCutInputs[selectedSeries]?.end ?? '');
                    if (!Number.isFinite(endVal)) return;
                    updateChannelCutRange(selectedSeries, current.start, endVal, current.enabled);
                  }}
                  disabled={!channelCutRanges[selectedSeries]?.enabled}
                  style={{ width: '100px', padding: '4px' }}
                  placeholder="结束(s)"
                  step="0.001"
                />
              </div>

              {/* 数据集自动对齐（放在切割面板中） */}
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ fontWeight: 'bold' }}>数据集对齐:</label>
                <label>
                  <input
                    type="checkbox"
                    checked={isDatasetAlignEnabled}
                    onChange={(e) => setIsDatasetAlignEnabled(e.target.checked)}
                  />
                  启用
                </label>
                <select
                  value={referenceDatasetId || ''}
                  onChange={(e) => setReferenceDatasetId(e.target.value)}
                  style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid #87e8de', minWidth: '160px' }}
                  title="选择参考数据集（其他数据集将对齐到它）"
                  disabled={!isDatasetAlignEnabled}
                >
                  {datasetIdsToShow.map(datasetId => {
                    const ds = datasetMap[datasetId];
                    if (!ds) return null;
                    return (
                      <option key={datasetId} value={datasetId}>
                        参考: {ds.name || ds.filename || datasetId}
                      </option>
                    );
                  })}
                </select>
                <button
                  onClick={handleAutoAlignDatasets}
                  disabled={!isDatasetAlignEnabled || isDatasetAligning || datasetIdsToShow.length < 2}
                  style={{
                    padding: '6px 16px',
                    backgroundColor: (!isDatasetAlignEnabled || isDatasetAligning) ? '#ccc' : '#13c2c2',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: (!isDatasetAlignEnabled || isDatasetAligning || datasetIdsToShow.length < 2) ? 'not-allowed' : 'pointer',
                    fontWeight: 'bold'
                  }}
                >
                  {isDatasetAligning ? '对齐中...' : '执行对齐'}
                </button>
                <button
                  onClick={clearDatasetAutoOffsets}
                  disabled={Object.keys(datasetAutoOffsets).length === 0}
                  style={{
                    padding: '6px 12px',
                    backgroundColor: Object.keys(datasetAutoOffsets).length === 0 ? '#ccc' : '#faad14',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: Object.keys(datasetAutoOffsets).length === 0 ? 'not-allowed' : 'pointer'
                  }}
                >
                  清除对齐
                </button>
                {Object.keys(datasetAutoOffsets).length > 0 && (
                  <span style={{ fontSize: '12px', color: '#52c41a' }}>
                    ✓ 已对齐 {Object.keys(datasetAutoOffsets).length} 个数据集
                  </span>
                )}
              </div>
            </div>
          )}

          {/* 【Feature 3】显示当前选中序列/分组的偏移信息（仅单通道模式） */}
          {!isMultiChannelMode && (isGroupShift ? (
            // 分组模式：显示分组偏移信息
            (groupShiftAmounts[selectedShiftGroup] !== undefined && groupShiftAmounts[selectedShiftGroup] !== 0) && (
              <div style={{ 
                marginBottom: '10px', 
                padding: '8px 12px', 
                backgroundColor: '#f6ffed', 
                borderRadius: '4px',
                border: '1px solid #b7eb8f',
                fontSize: '13px'
              }}>
                <strong>分组 [{selectedShiftGroup}]</strong> 整体偏移量: 
                <code style={{ marginLeft: '8px' }}>{groupShiftAmounts[selectedShiftGroup] || 0}</code>
                <span style={{ marginLeft: '15px', color: '#666' }}>
                  (包含 {getSeriesByGroup(selectedShiftGroup).length} 个序列)
                </span>
              </div>
            )
          ) : (
            // 单序列模式：显示序列偏移信息
            selectedSeries && (autoOffsets[selectedSeries] !== undefined || shiftAmount !== 0) && (
              <div style={{ 
                marginBottom: '10px', 
                padding: '8px 12px', 
                backgroundColor: '#fffbe6', 
                borderRadius: '4px',
                border: '1px solid #ffe58f',
                fontSize: '13px'
              }}>
                <strong>{selectedSeries}</strong> 偏移量: 
                自动 = <code>{autoOffsets[selectedSeries] || 0}</code>, 
                手动 = <code>{shiftAmount}</code>, 
                总计 = <code>{(autoOffsets[selectedSeries] || 0) + shiftAmount}</code>
              </div>
            )
          ))}

          {/* 【多通道模式】显示当前通道偏移信息 */}
          {isMultiChannelMode && selectedSeries && (Object.keys(datasetAutoOffsets).length > 0 || Object.keys(datasetManualOffsets).length > 0) && (
            <div style={{ 
              marginBottom: '10px', 
              padding: '8px 12px', 
              backgroundColor: '#e6fffb', 
              borderRadius: '4px',
              border: '1px solid #87e8de',
              fontSize: '13px'
            }}>
              <strong>{channelNames[selectedSeries] || selectedSeries}</strong> 偏移量: 
              手动(数据集) = <code>{Object.keys(datasetManualOffsets).length}</code> 个, 
              自动对齐(数据集) = <code>{Object.keys(datasetAutoOffsets).length}</code> 个
            </div>
          )}
        </>
      ) : (
        // 【新增】无数据时的提示UI
        <div style={{ 
          padding: '40px', 
          textAlign: 'center', 
          backgroundColor: '#f5f5f5', 
          borderRadius: '8px',
          border: '2px dashed #ccc',
          color: '#666',
          marginBottom: '20px'
        }}>
          暂无数据，请点击右上角上传 CSV 文件
          {isMultiChannelMode && (
            <div style={{ marginTop: '10px', fontSize: '12px' }}>
              多通道模式要求CSV格式: time[s], AI2-xx, AI2-yy, ... (通道数量可变，允许缺失)
            </div>
          )}
        </div>
      )}

      {/* 【大文件模式】元数据信息显示（展示当前主数据集） */}
      {isMultiChannelMode && primaryDataset?.is_large_file && (
        <div style={{
          marginBottom: '15px',
          padding: '10px 15px',
          backgroundColor: '#fff7e6',
          borderRadius: '6px',
          border: '1px solid #ffd591',
          display: 'flex',
          gap: '20px',
          alignItems: 'center',
          fontSize: '13px'
        }}>
          <span>📊 <strong>大文件模式</strong></span>
          <span>数据集: <strong>{primaryDataset.name}</strong></span>
          <span>数据点: <strong>{primaryDataset.total_rows.toLocaleString()}</strong></span>
          <span>时间范围: <strong>{primaryDataset.time_range[0].toFixed(4)}s ~ {primaryDataset.time_range[1].toFixed(4)}s</strong></span>
          <span>显示点数: <strong>{TARGET_DISPLAY_POINTS}</strong> (LTTB降采样)</span>
        </div>
      )}

      {/* 图表显示区域 */}
      {isMultiChannelMode && hasData ? (
        // 【多通道模式】显示多个独立的图表
        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(1, 1fr)', 
          gap: '15px',
          maxHeight: selectedChannels.length > 4 ? '800px' : 'auto',
          overflowY: selectedChannels.length > 4 ? 'auto' : 'visible'
        }}>
          {selectedChannels.map((channelId) => {
            const channelPlotData: Data[] = datasetIdsToShow.map((datasetId) => {
              const dataset = datasetMap[datasetId];
              if (!dataset) return null;

              let xData: number[] | Float32Array;
              let yData: number[] | Float32Array;

              if (dataset.is_large_file) {
                const displayData = channelDisplayDataByDataset[datasetId]?.[channelId];
                if (!displayData || displayData.x.length === 0) {
                  return null;
                }
                if (channelCutRanges[channelId]?.enabled && Number.isFinite(channelCutRanges[channelId].start) && Number.isFinite(channelCutRanges[channelId].end)) {
                  const startTime = channelCutRanges[channelId].start;
                  const endTime = channelCutRanges[channelId].end;
                  const startIdx = findStartIndexArray(displayData.x, startTime);
                  const endIdx = findEndIndexArray(displayData.x, endTime);
                  xData = displayData.x.slice(startIdx, endIdx);
                  yData = displayData.y.slice(startIdx, endIdx);
                } else {
                  xData = displayData.x;
                  yData = displayData.y;
                }
              } else {
                const series = rawDataByDataset[datasetId]?.[channelId];
                if (!series) return null;

                // 获取通道独立的切割范围（仅小文件）
                const channelCut = channelCutRanges[channelId];
                const start = (channelCut?.enabled && Number.isFinite(channelCut.start)) ? channelCut.start : undefined;
                const end = (channelCut?.enabled && Number.isFinite(channelCut.end)) ? channelCut.end : undefined;

                if (start !== undefined && end !== undefined) {
                  const startIdx = findStartIndex(series.x, start);
                  const endIdx = findEndIndex(series.x, end);
                  xData = series.x.subarray(startIdx, endIdx);
                  yData = series.y.subarray(startIdx, endIdx);
                } else {
                  xData = series.x;
                  yData = series.y;
                }
              }

              // 获取数据集偏移量（手动 + 自动对齐）
              const datasetManualOffset = datasetManualOffsets[datasetId] || 0;
              const datasetAutoOffset = isDatasetAlignEnabled ? (datasetAutoOffsets[datasetId] || 0) : 0;
              const totalOffset = datasetManualOffset + datasetAutoOffset;

              let currentX: number[] | Float32Array;
              if (totalOffset !== 0) {
                if (xData instanceof Float32Array) {
                  const len = xData.length;
                  const shifted = new Float32Array(len);
                  for (let i = 0; i < len; i++) {
                    shifted[i] = xData[i] + totalOffset;
                  }
                  currentX = shifted;
                } else {
                  currentX = xData.map(x => x + totalOffset);
                }
              } else {
                currentX = xData;
              }

              const color = getDatasetColor(datasetId);
              const displayName = dataset.name || dataset.filename || datasetId;

              return {
                name: displayName,
                x: currentX,
                y: yData,
                type: 'scatter',  // 避免 WebGL 上下文限制
                mode: 'lines',
                line: { width: 1.5, color }
              } as Data;
            }).filter(Boolean) as Data[];

            const isLoading = datasetIdsToShow.some(id => isLoadingChannelByDataset[id]?.[channelId]);
            const displayName = channelNames[channelId] || channelId;

            if (channelPlotData.length === 0) {
              return (
                <div 
                  key={channelId}
                  style={{
                    border: '1px solid #d9d9d9',
                    borderRadius: '8px',
                    padding: '40px',
                    backgroundColor: '#fafafa',
                    textAlign: 'center',
                    color: '#999'
                  }}
                >
                  {isLoading ? (
                    <span>⏳ 加载 {displayName} 中...</span>
                  ) : (
                    <span>暂无数据</span>
                  )}
                </div>
              );
            }

            const channelLayout: Partial<Layout> = {
              autosize: true,
              height: selectedChannels.length <= 2 ? 300 : 220,
              title: { 
                text: `${displayName}${isLoading ? ' ⏳' : ''}`, 
                font: { size: 12 } 
              },
              xaxis: { 
                title: { text: 'Time [s]', font: { size: 10 } },
                tickfont: { size: 9 },
                range: channelVisibleRanges[channelId] || undefined
              },
              yaxis: { 
                title: { text: 'Value', font: { size: 10 } },
                tickfont: { size: 9 }
              },
              margin: { l: 50, r: 20, t: 40, b: 40 },
              hovermode: 'closest',
              showlegend: datasetIdsToShow.length > 1,
              legend: { font: { size: 9 } },
              uirevision: `multi-channel-${channelId}`,
              shapes: referenceLineShapes
            };
            
            return (
              <div 
                key={channelId}
                style={{
                  border: selectedSeries === channelId ? '2px solid #1890ff' : '1px solid #d9d9d9',
                  borderRadius: '8px',
                  padding: '10px',
                  backgroundColor: selectedSeries === channelId ? '#e6f7ff' : 'white',
                  cursor: 'pointer',
                  position: 'relative',
                  width: '100%',
                  boxSizing: 'border-box'
                }}
                onClick={() => setSelectedSeries(channelId)}
              >
                {isLoading && (
                  <div style={{
                    position: 'absolute',
                    top: '5px',
                    right: '10px',
                    fontSize: '11px',
                    color: '#1890ff'
                  }}>
                    刷新中...
                  </div>
                )}
                <Plot
                  data={channelPlotData}
                  layout={channelLayout}
                  useResizeHandler={true}
                  style={{ width: '100%', height: '100%' }}
                  onRelayout={(e) => handleChannelRelayout(channelId, e)}
                  config={{ responsive: true, displayModeBar: false, editable: true, edits: { shapePosition: true } }}
                />
              </div>
            );
          })}
        </div>
      ) : (
        // 【单通道模式】显示单个合并的图表
        <Plot
          data={plotData}
          layout={chartLayout}
          useResizeHandler={true}
          style={{ width: '100%', height: '100%' }}
          onRelayout={handleRelayout}
          config={{ responsive: true, displayModeBar: true, editable: true, edits: { shapePosition: true } }}
        />
      )}

      {/* 【多通道模式】参考线添加按钮 */}
      {isMultiChannelMode && hasData && (
        <button
          onClick={addReferenceLine}
          title="添加参考线"
          style={{
            position: 'fixed',
            right: '24px',
            bottom: '24px',
            width: '52px',
            height: '52px',
            borderRadius: '50%',
            backgroundColor: '#13c2c2',
            color: 'white',
            border: 'none',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            cursor: 'pointer',
            fontSize: '28px',
            lineHeight: '52px',
            textAlign: 'center',
            zIndex: 1000
          }}
        >
          +
        </button>
      )}
    </div>
  );
};

export default TimeSeriesAnalyzer;
