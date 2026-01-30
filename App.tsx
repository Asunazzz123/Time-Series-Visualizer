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

const TimeSeriesAnalyzer: React.FC = () => {
  const [rawData, setRawData] = useState<ChartData | null>(null);
  const [selectedSeries, setSelectedSeries] = useState<string>('');
  const [shiftAmount, setShiftAmount] = useState<number>(0);
  
  // 状态：当前可见的X轴范围
  const [visibleRange, setVisibleRange] = useState<[number, number] | null>(null);
  
  // 上传相关状态
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

      // 逻辑修正：如果当前没有选中序列，或者选中的序列不在新数据中，默认选中第一个
      if (keys.length > 0) {
        setSelectedSeries(prev => {
           if (prev && keys.includes(prev)) return prev;
           return keys[0];
        });
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
      
      alert(`文件 ${file.name} 上传成功！`);
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
      alert("所有数据已清空");
    } catch (error) {
      console.error("Clear failed", error);
      alert("清空失败，请检查后端连接");
    }
  };

  // 2. 计算用于渲染的数据（核心性能优化区）
  const plotData = useMemo(() => {
    if (!rawData) return [];

    return Object.keys(rawData).map((seriesName) => {
      const series = rawData[seriesName];
      let currentX = series.x; 
      
      // 高性能平移计算
      if (seriesName === selectedSeries && shiftAmount !== 0) {
        const len = series.x.length;
        const shifted = new Float32Array(len);
        for (let i = 0; i < len; i++) {
          shifted[i] = series.x[i] + shiftAmount;
        }
        currentX = shifted;
      }

      return {
        name: seriesName,
        x: currentX, 
        y: series.y,
        type: 'scattergl', 
        mode: 'lines',
        line: { width: 1.5 } 
      } as Data;
    });
  }, [rawData, selectedSeries, shiftAmount]);

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
        <div style={{ display: 'flex', gap: '10px' }}>
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
        </div>
      </div>
      
      {/* 控制面板：有数据时显示控件，无数据时显示提示 */}
      {hasData ? (
        <div style={{ marginBottom: '20px', display: 'flex', gap: '20px', alignItems: 'center', flexWrap: 'wrap', backgroundColor: '#f9f9f9', padding: '15px', borderRadius: '8px', border: '1px solid #eee' }}>
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
                <option key={key} value={key}>{key}</option>
              ))}
            </select>
          </div>

          <div style={{ flex: 1, minWidth: '300px' }}>
            <label style={{ marginRight: '8px', fontWeight: 'bold' }}>X轴平移: </label>
            <input 
              type="range" 
              min={Math.floor(shiftLimits.min)}
              max={Math.ceil(shiftLimits.max)}
              step={shiftStep}
              value={shiftAmount}
              onChange={(e) => setShiftAmount(Number(e.target.value))}
              style={{ width: '60%', verticalAlign: 'middle' }}
            />
            <span style={{ marginLeft: '10px', fontFamily: 'monospace' }}>
              {shiftAmount}
            </span>
          </div>

          <button 
            onClick={() => {
              setShiftAmount(0);
              setVisibleRange(null);
            }}
            style={{ padding: '5px 15px', cursor: 'pointer' }}
          >
            重置视图
          </button>
        </div>
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