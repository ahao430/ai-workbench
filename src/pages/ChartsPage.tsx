import { useCallback, useEffect, useRef, useState } from 'react'
import { Splitter, Tabs, Typography } from 'antd'
import ChartTab, { type ChartLib, type ChartView, type SampleGroup } from '../components/charts/ChartTab'
import ChartChat, { type ChartChatHandle } from '../components/charts/ChartChat'
import DataBoard from '../components/charts/DataBoard'
import { loadDataset, saveDataset, type Dataset } from '../components/charts/data'
import { lsGet, lsSet } from '../components/diagram/shared'

/** 左画布/右 AI 对话的分栏宽度（百分比，指右侧面板），两个 tab 共用一份记忆 */
const SPLIT_KEY = 'aw-charts:split'
function loadSplit(): number {
  const v = Number(lsGet(SPLIT_KEY))
  return v >= 20 && v <= 78 ? v : 38
}
function saveSplit(sizes: number[]): void {
  const total = sizes[0] + sizes[1]
  if (total <= 0) return
  const pct = (sizes[1] / total) * 100
  if (pct >= 15 && pct <= 85) lsSet(SPLIT_KEY, String(Math.round(pct)))
}

const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

/** ECharts 示例（option 均为合法 ECharts option；模型生成同构配置） */
const EC_SAMPLES: SampleGroup[] = [
  {
    group: '基础图',
    items: {
      折线图: {
        title: { text: '近 7 天调用量', left: 'center' },
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'category', data: DAYS },
        yAxis: { type: 'value' },
        series: [{ type: 'line', smooth: true, data: [120, 200, 150, 80, 70, 110, 130], areaStyle: {} }],
      },
      面积图: {
        title: { text: '新旧版本访问趋势', left: 'center' },
        tooltip: { trigger: 'axis' },
        legend: { top: 30 },
        xAxis: { type: 'category', boundaryGap: false, data: DAYS },
        yAxis: { type: 'value' },
        series: [
          { name: '新版', type: 'line', smooth: true, areaStyle: { opacity: 0.25 }, data: [120, 132, 101, 134, 90, 230, 210] },
          { name: '旧版', type: 'line', smooth: true, areaStyle: { opacity: 0.25 }, data: [220, 182, 191, 234, 290, 330, 310] },
        ],
      },
      堆叠面积图: {
        title: { text: '渠道流量构成', left: 'center' },
        tooltip: { trigger: 'axis' },
        legend: { top: 30 },
        xAxis: { type: 'category', boundaryGap: false, data: DAYS },
        yAxis: { type: 'value' },
        series: [
          { name: '直接访问', type: 'line', smooth: true, stack: 'total', areaStyle: {}, emphasis: { focus: 'series' }, data: [120, 132, 101, 134, 90, 230, 210] },
          { name: '搜索引擎', type: 'line', smooth: true, stack: 'total', areaStyle: {}, emphasis: { focus: 'series' }, data: [220, 182, 191, 234, 290, 330, 310] },
          { name: '外部链接', type: 'line', smooth: true, stack: 'total', areaStyle: {}, emphasis: { focus: 'series' }, data: [90, 80, 100, 110, 120, 140, 130] },
        ],
      },
      柱状图: {
        title: { text: '模型调用次数（本周 vs 上周）', left: 'center' },
        tooltip: { trigger: 'axis' },
        legend: { top: 30 },
        xAxis: { type: 'category', data: ['gpt-4o', 'claude-3.5', 'glm-4', 'qwen-max', 'deepseek'] },
        yAxis: { type: 'value' },
        series: [
          { name: '本周', type: 'bar', data: [320, 280, 250, 180, 150] },
          { name: '上周', type: 'bar', data: [280, 300, 220, 205, 175] },
        ],
      },
      条形图: {
        title: { text: '模型调用次数', left: 'center' },
        tooltip: {},
        yAxis: { type: 'category', data: ['deepseek', 'qwen-max', 'glm-4', 'claude-3.5', 'gpt-4o'] },
        xAxis: { type: 'value' },
        series: [{ type: 'bar', data: [150, 180, 250, 280, 320] }],
      },
      堆叠柱状图: {
        title: { text: 'Token 用量（按用途）', left: 'center' },
        tooltip: { trigger: 'axis' },
        legend: { top: 30 },
        xAxis: { type: 'category', data: DAYS },
        yAxis: { type: 'value' },
        series: [
          { name: '聊天', type: 'bar', stack: 'total', data: [320, 302, 341, 374, 390, 450, 420] },
          { name: '画图', type: 'bar', stack: 'total', data: [120, 132, 101, 134, 290, 230, 210] },
          { name: 'Agent', type: 'bar', stack: 'total', data: [220, 182, 191, 234, 290, 330, 310] },
        ],
      },
      堆叠条形图: {
        title: { text: 'Token 用量（按用途，横向）', left: 'center' },
        tooltip: { trigger: 'axis' },
        legend: { top: 30 },
        yAxis: { type: 'category', data: DAYS },
        xAxis: { type: 'value' },
        series: [
          { name: '聊天', type: 'bar', stack: 'total', data: [320, 302, 341, 374, 390, 450, 420] },
          { name: '画图', type: 'bar', stack: 'total', data: [120, 132, 101, 134, 290, 230, 210] },
          { name: 'Agent', type: 'bar', stack: 'total', data: [220, 182, 191, 234, 290, 330, 310] },
        ],
      },
      饼图: {
        title: { text: 'Token 用量分布', left: 'center' },
        tooltip: { trigger: 'item' },
        legend: { orient: 'vertical', left: 'left' },
        series: [{ type: 'pie', radius: '62%', data: [{ value: 45, name: '聊天' }, { value: 25, name: '画图' }, { value: 18, name: 'Agent' }, { value: 12, name: '其他' }] }],
      },
      环形图: {
        title: { text: '技能使用占比', left: 'center' },
        tooltip: { trigger: 'item' },
        legend: { bottom: 0 },
        series: [
          {
            type: 'pie',
            radius: ['42%', '68%'],
            label: { show: true, formatter: '{b}: {d}%' },
            data: [{ value: 35, name: '写作' }, { value: 25, name: '翻译' }, { value: 22, name: '代码' }, { value: 18, name: '数据分析' }],
          },
        ],
      },
      散点图: {
        title: { text: '身高体重分布', left: 'center' },
        tooltip: {},
        xAxis: { name: '身高 cm', type: 'value', scale: true },
        yAxis: { name: '体重 kg', type: 'value', scale: true },
        series: [
          {
            type: 'scatter',
            symbolSize: 8,
            data: [[161, 51], [167, 59], [159, 49], [157, 63], [155, 53], [170, 59], [166, 69], [176, 66], [177, 75], [178, 71], [172, 69], [164, 59]],
          },
        ],
      },
    },
  },
  {
    group: '统计图',
    items: {
      雷达图: {
        title: { text: '模型能力对比', left: 'center' },
        tooltip: {},
        legend: { bottom: 0 },
        radar: {
          indicator: [
            { name: '推理', max: 100 },
            { name: '代码', max: 100 },
            { name: '数学', max: 100 },
            { name: '中文', max: 100 },
            { name: '速度', max: 100 },
          ],
        },
        series: [
          {
            type: 'radar',
            data: [
              { value: [88, 92, 85, 95, 70], name: 'GLM-4' },
              { value: [90, 95, 92, 80, 60], name: 'GPT-4o' },
            ],
          },
        ],
      },
      热力图: {
        title: { text: '一周活跃时段', left: 'center' },
        tooltip: {},
        grid: { top: 60 },
        xAxis: { type: 'category', data: DAYS },
        yAxis: { type: 'category', data: ['上午', '下午', '晚上'] },
        visualMap: { min: 0, max: 10, calculable: true, orient: 'horizontal', left: 'center', bottom: 0 },
        series: [
          {
            type: 'heatmap',
            data: [
              [0, 0, 5], [1, 0, 7], [2, 0, 3], [3, 0, 8], [4, 0, 9], [5, 0, 2], [6, 0, 1],
              [0, 1, 6], [1, 1, 8], [2, 1, 4], [3, 1, 7], [4, 1, 8], [5, 1, 3], [6, 1, 2],
              [0, 2, 8], [1, 2, 9], [2, 2, 6], [3, 2, 7], [4, 2, 6], [5, 2, 4], [6, 2, 5],
            ],
            label: { show: true },
          },
        ],
      },
      漏斗图: {
        title: { text: '招聘转化漏斗', left: 'center' },
        tooltip: { trigger: 'item', formatter: '{b}: {c}' },
        series: [
          {
            type: 'funnel',
            left: '10%',
            top: 60,
            bottom: 20,
            width: '80%',
            sort: 'descending',
            label: { show: true, position: 'inside' },
            data: [
              { value: 253, name: '简历筛选' },
              { value: 151, name: '初试人数' },
              { value: 113, name: '复试人数' },
              { value: 87, name: '录取人数' },
              { value: 59, name: '入职人数' },
            ],
          },
        ],
      },
      仪表盘: {
        title: { text: '剩余额度', left: 'center' },
        series: [
          {
            type: 'gauge',
            startAngle: 210,
            endAngle: -30,
            min: 0,
            max: 100,
            detail: { valueAnimation: true, formatter: '{value}%' },
            data: [{ value: 68, name: '额度' }],
            title: { offsetCenter: [0, '60%'] },
          },
        ],
      },
      K线图: {
        title: { text: '模拟行情（日 K）', left: 'center' },
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'category', data: ['09-01', '09-02', '09-03', '09-04', '09-05', '09-08'] },
        yAxis: { type: 'value', scale: true },
        series: [
          {
            type: 'candlestick',
            data: [
              [100, 104, 96, 105], [104, 101, 99, 107], [101, 108, 100, 109],
              [108, 106, 103, 110], [106, 112, 105, 113], [112, 110, 107, 115],
            ],
          },
        ],
      },
      箱线图: {
        title: { text: '接口耗时分布（ms）', left: 'center' },
        tooltip: { trigger: 'item' },
        xAxis: { type: 'category', data: ['网关', '聊天', '画图', 'Agent'] },
        yAxis: { type: 'value' },
        series: [
          {
            type: 'boxplot',
            data: [
              [20, 45, 60, 80, 140], [50, 90, 130, 180, 300], [200, 400, 600, 900, 1500], [100, 200, 350, 500, 800],
            ],
          },
        ],
      },
    },
  },
  {
    group: '关系与层级',
    items: {
      桑基图: {
        title: { text: '用户路径流转', left: 'center' },
        tooltip: { trigger: 'item' },
        series: [
          {
            type: 'sankey',
            layoutIterations: 0,
            top: 60,
            emphasis: { focus: 'adjacency' },
            data: [
              { name: '首页' }, { name: '搜索' }, { name: '推荐' }, { name: '详情页' },
              { name: '加购' }, { name: '下单' }, { name: '流失' },
            ],
            links: [
              { source: '首页', target: '搜索', value: 3000 },
              { source: '首页', target: '推荐', value: 2000 },
              { source: '搜索', target: '详情页', value: 2400 },
              { source: '推荐', target: '详情页', value: 1400 },
              { source: '搜索', target: '流失', value: 600 },
              { source: '推荐', target: '流失', value: 600 },
              { source: '详情页', target: '加购', value: 2200 },
              { source: '详情页', target: '流失', value: 1600 },
              { source: '加购', target: '下单', value: 1500 },
            ],
          },
        ],
      },
      旭日图: {
        title: { text: '功能用量层级', left: 'center' },
        tooltip: {},
        series: [
          {
            type: 'sunburst',
            radius: [0, '85%'],
            data: [
              {
                name: 'AI',
                children: [
                  { name: '聊天', value: 450, children: [{ name: '会话', value: 300 }, { name: '多模态', value: 150 }] },
                  { name: '画图', value: 250, children: [{ name: '文生图', value: 180 }, { name: '图生图', value: 70 }] },
                ],
              },
              {
                name: '办公',
                children: [
                  { name: '笔记', value: 120 },
                  { name: '图表', value: 80 },
                  { name: '流程图', value: 60 },
                ],
              },
            ],
          },
        ],
      },
      矩形树图: {
        title: { text: '技能分类用量', left: 'center' },
        tooltip: {},
        series: [
          {
            type: 'treemap',
            top: 60,
            roam: false,
            breadcrumb: { show: false },
            data: [
              { name: '写作', value: 560 },
              { name: '翻译', value: 500 },
              { name: '代码', value: 350 },
              { name: '数据分析', value: 240 },
              { name: 'PPT', value: 180 },
              { name: '周报', value: 120 },
              { name: '其他', value: 90 },
            ],
          },
        ],
      },
    },
  },
  {
    group: '组合图',
    items: {
      双轴折柱图: {
        title: { text: '调用量与耗时', left: 'center' },
        tooltip: { trigger: 'axis' },
        legend: { top: 30 },
        xAxis: { type: 'category', data: DAYS },
        yAxis: [
          { type: 'value', name: '次数' },
          { type: 'value', name: '耗时(ms)', splitLine: { show: false } },
        ],
        series: [
          { name: '调用量', type: 'bar', data: [120, 200, 150, 80, 70, 110, 130] },
          { name: '平均耗时', type: 'line', yAxisIndex: 1, smooth: true, data: [320, 302, 341, 374, 390, 450, 420] },
        ],
      },
    },
  },
]

/** AntV（Ant Design Charts）示例：type + 组件属性，字段与官方示例一致 */
const AV_SAMPLES: SampleGroup[] = [
  {
    group: '基础图',
    items: {
      折线图: {
        type: 'line',
        data: Array.from({ length: 12 }, (_, i) => ({ month: `${i + 1}月`, value: Math.round(200 + 120 * Math.sin(i / 2)) })),
        xField: 'month',
        yField: 'value',
        point: { size: 4 },
      },
      面积图: {
        type: 'area',
        data: [
          { month: '1月', value: 300 }, { month: '2月', value: 420 }, { month: '3月', value: 380 },
          { month: '4月', value: 550 }, { month: '5月', value: 500 }, { month: '6月', value: 640 },
        ],
        xField: 'month',
        yField: 'value',
        style: { fillOpacity: 0.4 },
      },
      堆叠面积图: {
        type: 'area',
        data: DAYS.flatMap((day, i) => [
          { day, type: '直接访问', value: [120, 132, 101, 134, 90, 230, 210][i] },
          { day, type: '搜索引擎', value: [220, 182, 191, 234, 290, 330, 310][i] },
          { day, type: '外部链接', value: [90, 80, 100, 110, 120, 140, 130][i] },
        ]),
        xField: 'day',
        yField: 'value',
        colorField: 'type',
        stack: true,
        style: { fillOpacity: 0.5 },
      },
      柱状图: {
        type: 'column',
        data: [
          { name: 'gpt-4o', week: '本周', value: 320 }, { name: 'claude-3.5', week: '本周', value: 280 }, { name: 'glm-4', week: '本周', value: 250 }, { name: 'qwen-max', week: '本周', value: 180 },
          { name: 'gpt-4o', week: '上周', value: 280 }, { name: 'claude-3.5', week: '上周', value: 300 }, { name: 'glm-4', week: '上周', value: 220 }, { name: 'qwen-max', week: '上周', value: 205 },
        ],
        xField: 'name',
        yField: 'value',
        colorField: 'week',
        group: true,
      },
      条形图: {
        type: 'bar',
        data: [{ name: '技能', value: 90 }, { name: 'Agent', value: 180 }, { name: '画图', value: 240 }, { name: '聊天', value: 320 }],
        xField: 'name',
        yField: 'value',
      },
      堆叠柱状图: {
        type: 'column',
        data: DAYS.flatMap((day, i) => [
          { day, type: '聊天', value: [320, 302, 341, 374, 390, 450, 420][i] },
          { day, type: '画图', value: [120, 132, 101, 134, 290, 230, 210][i] },
          { day, type: 'Agent', value: [220, 182, 191, 234, 290, 330, 310][i] },
        ]),
        xField: 'day',
        yField: 'value',
        colorField: 'type',
        stack: true,
      },
      堆叠条形图: {
        type: 'bar',
        data: DAYS.flatMap((day, i) => [
          { day, type: '聊天', value: [320, 302, 341, 374, 390, 450, 420][i] },
          { day, type: '画图', value: [120, 132, 101, 134, 290, 230, 210][i] },
          { day, type: 'Agent', value: [220, 182, 191, 234, 290, 330, 310][i] },
        ]),
        xField: 'day',
        yField: 'value',
        colorField: 'type',
        stack: true,
      },
      饼图: {
        type: 'pie',
        data: [{ name: '聊天', value: 45 }, { name: '画图', value: 25 }, { name: 'Agent', value: 18 }, { name: '其他', value: 12 }],
        angleField: 'value',
        colorField: 'name',
      },
      散点图: {
        type: 'scatter',
        data: [
          { height: 161, weight: 51, gender: '女' }, { height: 167, weight: 59, gender: '女' }, { height: 159, weight: 49, gender: '女' },
          { height: 170, weight: 66, gender: '男' }, { height: 176, weight: 71, gender: '男' }, { height: 178, weight: 75, gender: '男' },
          { height: 172, weight: 69, gender: '男' }, { height: 164, weight: 55, gender: '女' },
        ],
        xField: 'height',
        yField: 'weight',
        colorField: 'gender',
      },
    },
  },
  {
    group: '统计图',
    items: {
      双轴图: {
        type: 'dual-axes',
        data: [
          { time: '3月', value: 350, count: 800 }, { time: '4月', value: 900, count: 600 },
          { time: '5月', value: 300, count: 400 }, { time: '6月', value: 450, count: 380 }, { time: '7月', value: 470, count: 220 },
        ],
        xField: 'time',
        legend: true,
        children: [
          { type: 'interval', yField: 'value', style: { maxWidth: 80 } },
          { type: 'line', yField: 'count', style: { lineWidth: 2 }, axis: { y: { position: 'right' } } },
        ],
      },
      直方图: {
        type: 'histogram',
        data: [1.2, 2.5, 2.8, 3.1, 3.4, 3.6, 3.9, 4.2, 4.4, 4.7, 5.0, 5.2, 5.5, 5.8, 6.1, 6.4, 6.8, 7.2, 7.6, 8.1, 8.5, 9.0, 9.6, 10.2].map((value) => ({ value })),
        binField: 'value',
        binNumber: 8,
      },
      箱线图: {
        type: 'box',
        data: [
          { x: '网关', y: [20, 45, 60, 80, 140] },
          { x: '聊天', y: [50, 90, 130, 180, 300] },
          { x: '画图', y: [200, 400, 600, 900, 1500] },
          { x: 'Agent', y: [100, 200, 350, 500, 800] },
        ],
        xField: 'x',
        yField: 'y',
      },
      雷达图: {
        type: 'radar',
        data: [
          { dim: '推理', score: 88, model: 'GLM-4' }, { dim: '代码', score: 92, model: 'GLM-4' }, { dim: '数学', score: 85, model: 'GLM-4' }, { dim: '中文', score: 95, model: 'GLM-4' }, { dim: '速度', score: 70, model: 'GLM-4' },
          { dim: '推理', score: 90, model: 'GPT-4o' }, { dim: '代码', score: 95, model: 'GPT-4o' }, { dim: '数学', score: 92, model: 'GPT-4o' }, { dim: '中文', score: 80, model: 'GPT-4o' }, { dim: '速度', score: 60, model: 'GPT-4o' },
        ],
        xField: 'dim',
        yField: 'score',
        colorField: 'model',
        style: { lineWidth: 2 },
      },
      玫瑰图: {
        type: 'rose',
        data: [
          { name: '周一', value: 40 }, { name: '周二', value: 33 }, { name: '周三', value: 28 },
          { name: '周四', value: 22 }, { name: '周五', value: 20 }, { name: '周六', value: 15 }, { name: '周日', value: 12 },
        ],
        xField: 'name',
        yField: 'value',
        colorField: 'name',
        innerRadius: 0.2,
      },
      热力图: {
        type: 'heatmap',
        data: [
          { week: '周一', time: '上午', value: 5 }, { week: '周二', time: '上午', value: 7 }, { week: '周三', time: '上午', value: 3 },
          { week: '周一', time: '下午', value: 6 }, { week: '周二', time: '下午', value: 8 }, { week: '周三', time: '下午', value: 4 },
          { week: '周一', time: '晚上', value: 8 }, { week: '周二', time: '晚上', value: 9 }, { week: '周三', time: '晚上', value: 6 },
        ],
        xField: 'week',
        yField: 'time',
        colorField: 'value',
        sizeField: 'value',
        shapeField: 'square',
        scale: { size: { range: [12, 20] }, color: { range: ['#dddddd', '#9ec8e0', '#5fa4cd', '#2e7ab6', '#114d90'] } },
      },
      漏斗图: {
        type: 'funnel',
        data: [
          { stage: '简历筛选', number: 253 }, { stage: '初试人数', number: 151 }, { stage: '复试人数', number: 113 },
          { stage: '录取人数', number: 87 }, { stage: '入职人数', number: 59 },
        ],
        xField: 'stage',
        yField: 'number',
      },
      瀑布图: {
        type: 'waterfall',
        data: [
          { quarter: '第一季度', value: 620 }, { quarter: '第二季度', value: -260 },
          { quarter: '第三季度', value: 410 }, { quarter: '第四季度', value: 370 }, { quarter: '总计', value: 1140, isTotal: true },
        ],
        xField: 'quarter',
        yField: 'value',
      },
      子弹图: {
        type: 'bullet',
        data: [{ title: '满意度', ranges: 100, measures: 80, targets: 85 }],
      },
      玉玦图: {
        type: 'radial-bar',
        data: [
          { name: 'G6', star: 7100 }, { name: 'F2', star: 7346 }, { name: 'G2', star: 10178 },
          { name: 'L7', star: 2029 }, { name: 'AVA', star: 805 },
        ],
        xField: 'name',
        yField: 'star',
        innerRadius: 0.2,
      },
    },
  },
  {
    group: '指标与关系',
    items: {
      仪表盘: {
        type: 'gauge',
        data: { target: 120, total: 400, name: 'score' },
      },
      水球图: {
        type: 'liquid',
        percent: 0.3,
        style: { outlineBorder: 4, outlineDistance: 8, waveLength: 128 },
      },
      桑基图: {
        type: 'sankey',
        data: [
          { source: '首页', target: '搜索', value: 3000 }, { source: '首页', target: '推荐', value: 2000 },
          { source: '搜索', target: '详情页', value: 2400 }, { source: '推荐', target: '详情页', value: 1400 },
          { source: '详情页', target: '加购', value: 2200 }, { source: '加购', target: '下单', value: 1500 },
        ],
        layout: { nodeAlign: 'center', nodePadding: 0.03 },
        style: { labelSpacing: 3, linkFillOpacity: 0.4 },
      },
      矩形树图: {
        type: 'treemap',
        data: {
          name: 'root',
          children: [
            { name: '写作', value: 560 }, { name: '翻译', value: 500 }, { name: '代码', value: 350 },
            { name: '数据分析', value: 240 }, { name: 'PPT', value: 180 }, { name: '周报', value: 120 },
          ],
        },
        colorField: 'value',
        valueField: 'value',
        legend: false,
      },
      旭日图: {
        type: 'sunburst',
        data: {
          name: 'root',
          children: [
            {
              name: 'AI',
              children: [
                { name: '聊天', value: 450, children: [{ name: '会话', value: 300 }, { name: '多模态', value: 150 }] },
                { name: '画图', value: 250, children: [{ name: '文生图', value: 180 }, { name: '图生图', value: 70 }] },
              ],
            },
            { name: '办公', children: [{ name: '笔记', value: 120 }, { name: '图表', value: 80 }, { name: '流程图', value: 60 }] },
          ],
        },
        innerRadius: 0,
      },
      韦恩图: {
        type: 'venn',
        data: [
          { sets: ['前端'], size: 12, label: '前端' },
          { sets: ['后端'], size: 12, label: '后端' },
          { sets: ['测试'], size: 12, label: '测试' },
          { sets: ['前端', '后端'], size: 4, label: '全栈' },
          { sets: ['前端', '测试'], size: 2, label: '前端+测试' },
          { sets: ['后端', '测试'], size: 2, label: '后端+测试' },
        ],
        sizeField: 'size',
        style: { fillOpacity: 0.85 },
      },
      词云: {
        type: 'word-cloud',
        data: [
          { text: 'AI', value: 100 }, { text: '图表', value: 80 }, { text: '聊天', value: 90 }, { text: '画图', value: 70 },
          { text: '办公', value: 60 }, { text: '笔记', value: 55 }, { text: '流程图', value: 50 }, { text: '云效', value: 65 },
          { text: '语雀', value: 45 }, { text: '知识库', value: 40 }, { text: '技能', value: 58 }, { text: 'Agent', value: 62 },
          { text: '日报', value: 35 }, { text: '周报', value: 38 }, { text: '翻译', value: 42 },
        ],
        colorField: 'text',
        layout: { spiral: 'rectangular' },
      },
    },
  },
]

function firstSample(groups: SampleGroup[]): string {
  const first = Object.values(groups[0]?.items ?? {})[0]
  return JSON.stringify(first ?? {}, null, 2)
}

const DEFAULT_OPT: Record<ChartLib, string> = {
  echarts: firstSample(EC_SAMPLES),
  antv: firstSample(AV_SAMPLES),
}

const LS_OPT: Record<ChartLib, string> = { echarts: 'aw-charts:opt-echarts', antv: 'aw-charts:opt-antv' }

/**
 * 图表工作台：左侧多库画布（ECharts / Ant Design Charts，配置⇄图表切换），
 * 右侧 AI 对话走 function calling——模型调 render_chart 工具直接画到左侧，不在对话里输出配置。
 */
export default function ChartsPage() {
  const [tab, setTab] = useState<ChartLib>('echarts')
  // 两个库的 配置/图表/数据 视图相互独立：在一边切视图不影响另一边
  const [views, setViews] = useState<Record<ChartLib, ChartView>>({ echarts: 'chart', antv: 'chart' })
  const setView = useCallback(
    (lib: ChartLib, v: ChartView) => setViews((prev) => ({ ...prev, [lib]: v })),
    [],
  )
  const [optText, setOptText] = useState<Record<ChartLib, string>>(() => ({
    echarts: lsGet(LS_OPT.echarts) ?? DEFAULT_OPT.echarts,
    antv: lsGet(LS_OPT.antv) ?? DEFAULT_OPT.antv,
  }))
  // 数据看板数据集（两库共享）：本机 localStorage 持久化（超大文件自动放弃持久化）
  const [dataset, setDataset] = useState<Dataset | null>(() => loadDataset())
  useEffect(() => {
    saveDataset(dataset)
  }, [dataset])

  const chatRef = useRef<ChartChatHandle>(null)

  // 数据看板「根据数据更新配置」：让 AI 按最新数据重生成当前库的图表
  const updateFromData = useCallback(() => {
    const libLabel = tab === 'echarts' ? 'ECharts' : 'AntV Charts'
    chatRef.current?.requestUpdate(
      `请根据数据看板中的最新数据更新左侧当前 ${libLabel} 图表：保持当前图型与整体风格，以数据集的最新字段与数值重新生成完整配置并调用 render_chart 工具；若当前图用的是示例数据则改为使用数据集数据。`,
    )
  }, [tab])

  const setOpt = useCallback((lib: ChartLib, text: string) => {
    setOptText((prev) => ({ ...prev, [lib]: text }))
    lsSet(LS_OPT[lib], text)
  }, [])

  // 工具执行入口：切到对应库的 tab 并展示图表
  const applyChart = useCallback(
    (lib: ChartLib, option: Record<string, unknown>) => {
      setOpt(lib, JSON.stringify(option, null, 2))
      setTab(lib)
      setView(lib, 'chart')
    },
    [setOpt, setView],
  )

  // 对话区上传数据文件：导入后切到数据视图确认
  const onDatasetFromChat = useCallback(
    (ds: Dataset) => {
      setDataset(ds)
      setView(tab, 'data')
    },
    [tab, setView],
  )

  const dataPane = (
    <DataBoard dataset={dataset} onChange={setDataset} onUpdateConfig={updateFromData} />
  )

  return (
    <div className="mx-auto flex h-full w-full max-w-7xl flex-col px-6 py-5">
      <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 12 }}>
        图表
      </Typography.Title>
      <Splitter layout="horizontal" className="min-h-0 flex-1" onResizeEnd={saveSplit}>
        <Splitter.Panel min="30%" max="78%">
          <Tabs
            activeKey={tab}
            onChange={(k) => setTab(k as ChartLib)}
            className="charts-tabs h-full"
            items={[
              {
                key: 'echarts',
                label: 'ECharts',
                children: (
                  <ChartTab
                    lib="echarts"
                    text={optText.echarts}
                    onText={(t) => setOpt('echarts', t)}
                    view={views.echarts}
                    onView={(v) => setView('echarts', v)}
                    samples={EC_SAMPLES}
                    data={dataPane}
                    dataCount={dataset?.rows.length}
                  />
                ),
              },
              {
                key: 'antv',
                label: 'AntV Charts',
                children: (
                  <ChartTab
                    lib="antv"
                    text={optText.antv}
                    onText={(t) => setOpt('antv', t)}
                    view={views.antv}
                    onView={(v) => setView('antv', v)}
                    samples={AV_SAMPLES}
                    data={dataPane}
                    dataCount={dataset?.rows.length}
                  />
                ),
              },
            ]}
          />
        </Splitter.Panel>
        <Splitter.Panel min="22%" defaultSize={`${loadSplit()}%`}>
          <ChartChat
            ref={chatRef}
            storageKey="aw-charts:chat"
            getContext={() => ({ echarts: optText.echarts, antv: optText.antv })}
            onRender={applyChart}
            getData={() => dataset}
            onDataset={onDatasetFromChat}
          />
        </Splitter.Panel>
      </Splitter>
    </div>
  )
}
