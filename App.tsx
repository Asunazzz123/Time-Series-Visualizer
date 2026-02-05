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
    }
  };

  // 初始加载
  useEffect(() => {
    fetchData();
  }, []);

  // 处理文件上传
  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    const formData = new FormData();
    formData.append('file', file); 

    setIsUploading(true);
    try {
      await axios.post('http://localhost:8000/upload', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });
      
      // 【Feature 1】上传后立即分配到指定分组
      const seriesPrefix = file.name.replace('.csv', '');
      setGroupAssignment(prev => ({
        ...prev,
        [seriesPrefix]: uploadGroup
      }));
      
      alert(`文件 ${file.name} 上传成功！已分配到 ${uploadGroup} 组`);
      await fetchData(); 
    } catch (error) {
      console.error("Upload failed", error);
      alert("上传失败，请检查后端服务是否启动");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // 【新增】处理清空数据
  const handleClearData = async () => {
    if (!rawData || Object.keys(rawData).length === 0) return;
    
    if (!window.confirm("确定要清空所有已加载的序列吗？这将重置图表。")) {
      return;
    }

    try {
      await axios.post('http://localhost:8000/clear');
      // 清空本地状态
      setRawData({}); 
      setSelectedSeries('');
      setShiftAmount(0);
      setVisibleRange(null);
      setGroupAssignment({});
      setAutoOffsets({});
      setCutRange({ start: 0, end: 1000, enabled: false });
      alert("所有数据已清空");
    } catch (error) {
      console.error("Clear failed", error);
      alert("清空失败，请检查后端连接");
    }
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
    if (!rawData) return [];

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
        type: 'scattergl', 
        mode: 'lines',
        line: { width: 1.5, color } 
      } as Data;
    });
  }, [rawData, selectedSeries, shiftAmount, groupAssignment, autoOffsets, cutRange, groups, isGroupShift, groupShiftAmounts, selectedShiftGroup]);

  // 计算数据的绝对范围
  const dataRange = useMemo<[number, number] | null>(() => {
    if (!rawData || !selectedSeries) return null;
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
  }, [rawData, selectedSeries]);

  const effectiveRange = visibleRange ?? dataRange;

  // 计算步长
  const shiftStep = useMemo(() => {
    if (!effectiveRange) return 1;
    const length = Math.abs(effectiveRange[1] - effectiveRange[0]);
    const rawStep = length === 0 ? 1 : length * 0.01;
    return Math.max(1, Math.ceil(rawStep)); 
  }, [effectiveRange]);

  // 计算平移限制
  const shiftLimits = useMemo(() => {
    if (!effectiveRange) return { min: -1000, max: 1000 };
    const length = Math.abs(effectiveRange[1] - effectiveRange[0]);
    const limit = Math.max(1000, length * 1.5); 
    return { min: -limit, max: limit };
  }, [effectiveRange]);

  const handleRelayout = (event: PlotRelayoutEvent) => {
    const e = event as Record<string, any>;
    const x0 = e['xaxis.range[0]'];
    const x1 = e['xaxis.range[1]'];
    const autorange = e['xaxis.autorange'];

    if (x0 !== undefined && x1 !== undefined) {
      setVisibleRange([Number(x0), Number(x1)]);
    } else if (autorange === true || e['xaxis.autorange'] === true) {
      setVisibleRange(null);
    }
  };

  const chartLayout = useMemo<Partial<Layout>>(() => {
    return {
      width: 800,
      height: 500,
      title: { text: '多序列时序对比工具' },
      xaxis: { 
        title: { text: 'Time / Index' },
        range: visibleRange ? visibleRange : undefined,
      },
      yaxis: { title: { text: 'Value' } },
      hovermode: 'closest',
      uirevision: 'true', 
    };
  }, [visibleRange]);

  // 判断是否有数据
  const hasData = rawData && Object.keys(rawData).length > 0;

  // 加载中状态（仅在初始化且无数据时显示）
  if (!rawData && !isUploading) return <div>Loading High-Performance Data...</div>;

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
      
      {/* 顶部工具栏：标题与操作按钮 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2 style={{ margin: 0 }}>时序交互平移工具</h2>
        
        {/* 按钮区域 */}
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          {/* 【Feature 1】上传分组选择 - 动态分组 */}
          <select
            value={uploadGroup}
            onChange={(e) => setUploadGroup(e.target.value)}
            style={{ padding: '8px', borderRadius: '4px', border: '1px solid #ccc' }}
          >
            {groups.map(g => (
              <option key={g.name} value={g.name}>上传到: {g.name}</option>
            ))}
          </select>

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

          {/* 【Feature 1】分组管理按钮 */}
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
        </div>
      </div>

      {/* 【Feature 1】分组管理面板 - 动态分组 */}
      {showGroupManager && hasData && (
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
          {/* 原有控制面板 */}
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

          {/* 【Feature 2 & 3】切割与对齐控制面板 */}
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

          {/* 【Feature 3】显示当前选中序列/分组的偏移信息 */}
          {isGroupShift ? (
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
        </div>
      )}

      <Plot
        data={plotData}
        layout={chartLayout}
        onRelayout={handleRelayout}
        config={{ responsive: true, displayModeBar: true }}
      />
    </div>
  );
};

export default TimeSeriesAnalyzer;