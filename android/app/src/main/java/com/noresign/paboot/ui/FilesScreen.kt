package com.noresign.paboot.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material.icons.rounded.FilterAlt
import androidx.compose.material.icons.rounded.FilterAltOff
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.noresign.paboot.data.WorkspaceSelection
import com.noresign.paboot.model.diff.SplitDiffKind
import com.noresign.paboot.model.diff.parseSplitDiff
import com.noresign.paboot.network.daemon.dto.ChangedFileDto
import com.noresign.paboot.network.daemon.dto.FileEntryDto
import com.noresign.paboot.ui.component.PullToRefreshContainer
import com.noresign.paboot.ui.component.TopBarActionButton
import com.noresign.paboot.viewmodel.DiffUiState
import com.noresign.paboot.viewmodel.FileBrowserUiState
import com.noresign.paboot.viewmodel.FileContentUiState
import com.noresign.paboot.viewmodel.FilesMode
import com.noresign.paboot.viewmodel.FilesUiState
import com.noresign.paboot.viewmodel.FilesViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FilesScreen(
    bottomOverlayPadding: Dp = 0.dp,
    viewModel: FilesViewModel = viewModel(),
) {
    val uiState by viewModel.uiState.collectAsState()
    val mode by viewModel.mode.collectAsState()
    val diffState by viewModel.diffState.collectAsState()
    val fileBrowser by viewModel.fileBrowser.collectAsState()
    val fileContent by viewModel.fileContent.collectAsState()
    val media by viewModel.media.collectAsState()
    val selectedWorkspacePath by WorkspaceSelection.selectedPath.collectAsState()
    val root by viewModel.root.collectAsState()
    val knownRoots by viewModel.knownRoots.collectAsState()
    val shortcuts by viewModel.shortcuts.collectAsState()
    val rootPicker by viewModel.rootPicker.collectAsState()
    val rootError by viewModel.rootError.collectAsState()
    val refreshing by viewModel.refreshing.collectAsState()
    var fileBrowserQuery by rememberSaveable { mutableStateOf("") }
    val currentRoot = root ?: selectedWorkspacePath.orEmpty()
    val focusManager = LocalFocusManager.current
    val keyboardController = LocalSoftwareKeyboardController.current
    val dismissInput: () -> Unit = {
        focusManager.clearFocus()
        keyboardController?.hide()
    }

    // 每次进入文件 Tab 自动拉一次：agent 在后台改了文件、或别处动了 tab 行，
    // 切回来就能看到，不用手点「刷新」。切走时本页会离开 composition，切回来再触发。
    LaunchedEffect(Unit) { viewModel.refresh() }

    // 文本 / diff / 媒体都是本页内的浮层，不是导航目的地（见下面的 when）。不拦返回键的话，
    // 系统返回会冒泡到 NavHost，把 MAIN 弹掉——表现就是「在文件详情里按返回直接退出 App」。
    // 按渲染优先级逐个关（媒体 > 文本 > diff）：从 diff 再点开全文时 fileContent 叠在
    // diffState 之上，关掉文本正好回到刚才那张 diff。
    val hasDetail = media != null || fileContent != null || diffState != null
    BackHandler(enabled = hasDetail) {
        when {
            media != null -> viewModel.closeMedia()
            fileContent != null -> viewModel.closeFile()
            diffState != null -> viewModel.closeDiff()
        }
    }

    when {
        // 媒体预览排在最前：它是从「全部文件」点进来的最上层浮层（和文本/diff 互斥）。
        media != null -> MediaViewerScreen(
            state = media!!,
            client = viewModel.mediaClient(),
            onBack = viewModel::closeMedia,
            bottomOverlayPadding = bottomOverlayPadding,
        )
        fileContent != null -> FileContentScreen(
            state = fileContent!!,
            onBack = viewModel::closeFile,
            bottomOverlayPadding = bottomOverlayPadding,
        )
        diffState != null -> DiffScreen(
            state = diffState!!,
            onBack = viewModel::closeDiff,
            onOpenFullFile = viewModel::openDiffFileContent,
            bottomOverlayPadding = bottomOverlayPadding,
        )
        else -> Scaffold(
            topBar = {
                TopAppBar(
                    title = {
                        Column {
                            Text("文件")
                            selectedWorkspacePath?.let {
                                Text(
                                    it,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    },
                    // 没有「刷新」按钮：每次进入本 tab 会自动拉一次（见上面的 LaunchedEffect）。
                    actions = {
                        if (mode == FilesMode.All) {
                            TopBarActionButton(
                                icon = if (fileBrowser.showHidden) {
                                    Icons.Rounded.VisibilityOff
                                } else {
                                    Icons.Rounded.Visibility
                                },
                                contentDescription = if (fileBrowser.showHidden) "隐藏隐藏项" else "显示隐藏项",
                                onClick = { dismissInput(); viewModel.toggleShowHidden() },
                            )
                            TopBarActionButton(
                                icon = if (fileBrowser.showIgnored) {
                                    Icons.Rounded.FilterAltOff
                                } else {
                                    Icons.Rounded.FilterAlt
                                },
                                contentDescription = if (fileBrowser.showIgnored) "隐藏忽略项" else "显示忽略项",
                                onClick = { dismissInput(); viewModel.toggleShowIgnored() },
                            )
                        }
                    },
                )
            },
        ) { innerPadding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding),
            ) {
                SegmentedTabs(mode = mode, onSelect = viewModel::selectMode)
                RootBar(
                    root = currentRoot,
                    knownRoots = knownRoots,
                    shortcuts = shortcuts,
                    error = rootError,
                    onSelectRoot = viewModel::selectRoot,
                    onAddRoot = viewModel::openAddShortcutPicker,
                    onRemoveShortcut = viewModel::removeShortcut,
                    onDismissError = viewModel::dismissRootError,
                )
                // 下拉刷新只包住列表区：分段控制和根栏在它上面，不参与下拉手势。
                PullToRefreshContainer(
                    isRefreshing = refreshing,
                    onRefresh = viewModel::pullRefresh,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                ) {
                    when (mode) {
                        FilesMode.Changes -> ChangesContent(
                            state = uiState,
                            bottomOverlayPadding = bottomOverlayPadding,
                            onRetry = viewModel::refresh,
                            onOpen = viewModel::openDiff,
                            onOpenRepo = viewModel::openChildDir,
                        )
                        FilesMode.All -> FileBrowserContent(
                            state = fileBrowser,
                            bottomOverlayPadding = bottomOverlayPadding,
                            query = fileBrowserQuery,
                            onQueryChange = { fileBrowserQuery = it },
                            onBrowse = { fileBrowserQuery = ""; viewModel.browse(it) },
                            onLoadMore = viewModel::loadMore,
                            onOpenFile = viewModel::openFile,
                            onRetry = viewModel::refresh,
                        )
                    }
                }
            }
    }
    }

    // 目录选择器：绝对路径浏览（复用工作区管理页的那个），所以能选到工作区之外。
    // 确认后加成浏览书签并切过去——不改权限，所以不禁用「已是工作区」的目录。
    rootPicker?.let { picker ->
        DirectoryPickerDialog(
            state = picker,
            onDismiss = viewModel::closeRootPicker,
            onBrowse = viewModel::pickupRootDir,
            onToggleHidden = viewModel::toggleRootPickerHidden,
            onSelect = viewModel::confirmRootPick,
            title = "添加浏览目录",
            selectLabel = "加为快捷（不改权限）",
            selectEnabled = true,
        )
    }
}

/**
 * 当前浏览根 + tab 行。tab 有两类，视觉上区别对待：
 * - **工作区的根**（主目录、附加目录）——只在别处管理，这里不可删；
 * - **浏览书签**（`shortcuts`）——纯便利入口，带「×」可就地移除，不涉及 agent 权限。
 * 末尾「+ 目录」是**唯一的**新增入口：选中即加成书签并切过去（导航与收藏合一）。
 */
@Composable
private fun RootBar(
    root: String,
    knownRoots: List<String>,
    shortcuts: List<String>,
    error: String?,
    onSelectRoot: (String?) -> Unit,
    onAddRoot: () -> Unit,
    onRemoveShortcut: (String) -> Unit,
    onDismissError: () -> Unit,
) {
    val chipState = rememberLazyListState()
    val chipCount = knownRoots.size + shortcuts.size
    val activeIndex = knownRoots.indexOf(root).takeIf { it >= 0 }
        ?: shortcuts.indexOf(root).let { if (it >= 0) knownRoots.size + it else -1 }

    // 切根时把高亮的 chip 滚进视野，否则 tab 多了以后当前栏在屏幕外，看不出去在哪。
    // 已经可见就不动，避免每次进入页面都平白滚一下。
    LaunchedEffect(activeIndex, chipCount) {
        if (activeIndex < 0) return@LaunchedEffect
        val visible = chipState.layoutInfo.visibleItemsInfo.any { it.index == activeIndex }
        if (!visible) chipState.animateScrollToItem(activeIndex)
    }

    Column(modifier = Modifier.fillMaxWidth()) {
        // chips 在左边滚动，「+ 目录」钉在右边不参与滚动——否则 tab 一多它就被挤出屏幕，
        // 想加新目录得先滑到底。行始终渲染，即使一个附加目录/书签都还没有。
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(36.dp)
                .padding(horizontal = 20.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            LazyRow(
                state = chipState,
                modifier = Modifier.weight(1f),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                items(knownRoots) { candidate ->
                    RootChip(
                        label = rootLabel(candidate),
                        selected = candidate == root,
                        onSelect = { onSelectRoot(candidate) },
                    )
                }
                items(shortcuts) { candidate ->
                    RootChip(
                        label = rootLabel(candidate),
                        selected = candidate == root,
                        onSelect = { onSelectRoot(candidate) },
                        onRemove = { onRemoveShortcut(candidate) },
                    )
                }
            }
            Text(
                "+ 目录",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
                maxLines = 1,
                modifier = Modifier
                    .clickable { onAddRoot() }
                    .padding(start = 12.dp, top = 4.dp, bottom = 4.dp),
            )
        }
        error?.let { message ->
            Row(
                modifier = Modifier.padding(horizontal = 20.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    message,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.error,
                    maxLines = 2,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    "知道了",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier
                        .clickable { onDismissError() }
                        .padding(start = 8.dp, top = 4.dp, bottom = 4.dp),
                )
            }
        }
    }
}

/** 根栏胶囊：与 iOS 的 FileRootBarView 一致（28dp 高、14dp 圆角、选中浅主色底）。 */
@Composable
private fun RootChip(
    label: String,
    selected: Boolean,
    onSelect: () -> Unit,
    onRemove: (() -> Unit)? = null,
) {
    Row(
        modifier = Modifier
            .height(28.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(
                if (selected) MaterialTheme.colorScheme.primaryContainer
                else MaterialTheme.colorScheme.surface
            )
            .clickable(onClick = onSelect)
            .padding(start = 12.dp, end = if (onRemove != null) 4.dp else 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelSmall,
            color = if (selected) MaterialTheme.colorScheme.primary
            else MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (onRemove != null) {
            Spacer(modifier = Modifier.width(2.dp))
            Text(
                "×",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .clickable(onClick = onRemove)
                    .padding(horizontal = 6.dp, vertical = 4.dp),
            )
        }
    }
}

private fun rootLabel(path: String): String = path.substringAfterLast('/').ifBlank { path }

/** iOS 风格分段控件：灰色轨道 + 白色选中 thumb。 */
@Composable
private fun SegmentedTabs(mode: FilesMode, onSelect: (FilesMode) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp, vertical = 8.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        SegmentTab(
            label = "改动",
            selected = mode == FilesMode.Changes,
            modifier = Modifier.weight(1f),
            onClick = { onSelect(FilesMode.Changes) },
        )
        SegmentTab(
            label = "全部文件",
            selected = mode == FilesMode.All,
            modifier = Modifier.weight(1f),
            onClick = { onSelect(FilesMode.All) },
        )
    }
}

@Composable
private fun RowScope.SegmentTab(
    label: String,
    selected: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(8.dp)
    Box(
        modifier = modifier
            .height(30.dp)
            .then(if (selected) Modifier.shadow(1.dp, shape) else Modifier)
            .clip(shape)
            .background(if (selected) MaterialTheme.colorScheme.surface else Color.Transparent)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            color = if (selected) MaterialTheme.colorScheme.primary
            else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ChangesContent(
    state: FilesUiState,
    bottomOverlayPadding: Dp,
    onRetry: () -> Unit,
    onOpen: (ChangedFileDto) -> Unit,
    onOpenRepo: (String) -> Unit,
) {
    when (state) {
        is FilesUiState.Loading -> ScrollableHint {
            CircularProgressIndicator()
        }
        is FilesUiState.Error -> ScrollableHint { ErrorContent(state.message, onRetry) }
        is FilesUiState.Content -> when {
            !state.isGitRepo && state.repos.isNotEmpty() -> RepoList(
                state.repos,
                onOpenRepo,
                bottomOverlayPadding,
            )
            !state.isGitRepo -> ScrollableHint {
                EmptyHint(
                    title = "此目录不是 Git 仓库",
                    body = "它下面的仓库会列在这里；想看别的目录请点上方「+ 目录」。",
                )
            }
            state.files.isEmpty() -> ScrollableHint {
                EmptyHint(
                    title = "当前没有未提交的改动",
                    body = "Agent 修改文件后会出现在这里。",
                )
            }
            else -> LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(
                    start = 20.dp,
                    top = 8.dp,
                    end = 20.dp,
                    bottom = 12.dp + bottomOverlayPadding,
                ),
                verticalArrangement = Arrangement.spacedBy(0.dp),
            ) {
                items(state.files, key = { it.path }) { file ->
                    ChangeRow(file = file, onClick = { onOpen(file) })
                }
            }
        }
    }
}

/**
 * 把不能自己滚动的空态/错误态/加载态放进一个占满视口的滚动容器。
 *
 * 下拉刷新靠 nested scroll 拿手势，而手势只能由**可滚动节点**派发——直接放一个
 * `Box`/`Column` 的话，列表为空时根本拉不动。用 LazyColumn 的单 item 而不是
 * `verticalScroll`：`fillParentMaxSize` 给出**有界**高度，内容才能垂直居中
 * （`verticalScroll` 会用无限高度测量子项，居中会失效）。
 */
@Composable
private fun ScrollableHint(content: @Composable () -> Unit) {
    LazyColumn(modifier = Modifier.fillMaxSize()) {
        item {
            Box(Modifier.fillParentMaxSize(), contentAlignment = Alignment.Center) {
                content()
            }
        }
    }
}

@Composable
private fun RepoList(repos: List<String>, onOpenRepo: (String) -> Unit, bottomOverlayPadding: Dp) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(
            start = 20.dp,
            top = 8.dp,
            end = 20.dp,
            bottom = 12.dp + bottomOverlayPadding,
        ),
        verticalArrangement = Arrangement.spacedBy(0.dp),
    ) {
        item {
            Text(
                "此目录不是 Git 仓库，下面是它子目录里的仓库",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(vertical = 8.dp),
            )
        }
        items(repos, key = { it }) { repo ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onOpenRepo(repo) }
                    .padding(vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = Icons.Rounded.Folder,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(22.dp),
                )
                Spacer(modifier = Modifier.width(12.dp))
                Text(
                    repo.substringAfterLast('/'),
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    "Git 仓库",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(modifier = Modifier.width(4.dp))
                Icon(
                    imageVector = Icons.Rounded.ChevronRight,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}

@Composable
private fun FileBrowserContent(
    state: FileBrowserUiState,
    bottomOverlayPadding: Dp,
    query: String,
    onQueryChange: (String) -> Unit,
    onBrowse: (String?) -> Unit,
    onLoadMore: () -> Unit,
    onOpenFile: (FileEntryDto) -> Unit,
    onRetry: () -> Unit,
) {
    val visibleEntries = remember(state.entries, query) {
        if (query.isBlank()) state.entries else state.entries.filter { it.name.contains(query, ignoreCase = true) }
    }
    val parent = state.parent
    val focusManager = LocalFocusManager.current
    val keyboardController = LocalSoftwareKeyboardController.current
    val dismissInput: () -> Unit = {
        focusManager.clearFocus()
        keyboardController?.hide()
        Unit
    }
    val dismissAndBrowse: (String?) -> Unit = { path ->
        dismissInput()
        onBrowse(path)
    }
    var searchBounds by remember { mutableStateOf<Rect?>(null) }
    var rootPosition by remember { mutableStateOf(Offset.Zero) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .onGloballyPositioned { rootPosition = it.positionInRoot() }
            .pointerInput(Unit) {
                val touchSlop = viewConfiguration.touchSlop
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                    val up = waitForUpOrCancellation(pass = PointerEventPass.Initial)
                    if (up != null && (up.position - down.position).getDistance() <= touchSlop) {
                        val tapInRoot = down.position + rootPosition
                        if (searchBounds?.contains(tapInRoot) != true) dismissInput()
                    }
                }
            },
    ) {
        val breadcrumbScroll = rememberScrollState()
        LaunchedEffect(state.path, breadcrumbScroll.maxValue) {
            breadcrumbScroll.scrollTo(breadcrumbScroll.maxValue)
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(28.dp)
                .padding(horizontal = 20.dp)
                .horizontalScroll(breadcrumbScroll),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            breadcrumbs(state.path).forEachIndexed { index, crumb ->
                if (index > 0) {
                    Text(
                        "/",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.labelMedium.copy(fontFamily = FontFamily.Monospace),
                        modifier = Modifier.padding(horizontal = 2.dp),
                    )
                }
                Text(
                    crumb.label,
                    style = MaterialTheme.typography.labelMedium.copy(
                        fontFamily = FontFamily.Monospace,
                        fontWeight = if (index == 0) FontWeight.SemiBold else FontWeight.Normal,
                    ),
                    color = if (index == 0) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier
                        .clickable { dismissAndBrowse(crumb.path) }
                        .padding(horizontal = 2.dp, vertical = 4.dp),
                )
            }
        }
        CompactSearchField(
            value = query,
            onValueChange = onQueryChange,
            placeholder = "筛选当前目录",
            onSearch = dismissInput,
            modifier = Modifier
                .padding(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 4.dp)
                .onGloballyPositioned { searchBounds = it.boundsInRoot() },
        )

        LazyColumn(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(
                start = 20.dp,
                top = 8.dp,
                end = 20.dp,
                bottom = 12.dp + bottomOverlayPadding,
            ),
            verticalArrangement = Arrangement.spacedBy(0.dp),
        ) {
            if (parent != null) {
                item(key = "__up__") {
                    UpRow(onClick = { dismissAndBrowse(parent) })
                }
            }
            if (state.loading && state.entries.isEmpty()) {
                item { Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
            }

            state.error?.let { message ->
                item { ErrorContent(message, onRetry) }
            }

            if (visibleEntries.isEmpty() && query.isNotBlank()) {
                item { Text("当前目录没有匹配项", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }

            items(visibleEntries, key = { it.path }) { entry ->
                FileEntryRow(
                    entry = entry,
                    onOpen = {
                        dismissInput()
                        onOpenFile(entry)
                    },
                    onBrowse = { path ->
                        dismissInput()
                        onBrowse(path)
                    },
                )
            }

            if (state.nextCursor != null) {
                item {
                    OutlinedButton(
                        onClick = { dismissInput(); onLoadMore() },
                        enabled = !state.loadingMore,
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(if (state.loadingMore) "加载中…" else "加载更多") }
                }
            }
        }
    }
}

private data class Breadcrumb(val label: String, val path: String?)

private fun breadcrumbs(path: String): List<Breadcrumb> {
    // 根不一定是工作区（可以切到任意目录），所以第一段用中性名。
    val items = mutableListOf(Breadcrumb("根目录", null))
    var current = ""
    for (part in path.split('/').filter { it.isNotBlank() }) {
        current = if (current.isEmpty()) part else "$current/$part"
        items += Breadcrumb(part, current)
    }
    return items
}

@Composable
private fun CompactSearchField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    onSearch: () -> Unit,
    modifier: Modifier = Modifier,
) {
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = true,
        textStyle = MaterialTheme.typography.bodySmall.copy(color = MaterialTheme.colorScheme.onSurface),
        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        keyboardActions = KeyboardActions(onSearch = { onSearch() }),
        modifier = modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp))
            .padding(horizontal = 10.dp, vertical = 8.dp),
        decorationBox = { innerTextField ->
            Box {
                if (value.isEmpty()) {
                    Text(
                        placeholder,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                innerTextField()
            }
        },
    )
}

/** 「全部文件」里的上一级入口：与 iOS 相同，作为列表首行而不是独立按钮。 */
@Composable
private fun UpRow(onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.Rounded.ArrowUpward,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(22.dp),
        )
        Spacer(modifier = Modifier.width(12.dp))
        Text(
            "上一级",
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f),
        )
        Icon(
            imageVector = Icons.Rounded.ChevronRight,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(18.dp),
        )
    }
}

@Composable
private fun FileEntryRow(
    entry: FileEntryDto,
    onOpen: () -> Unit,
    onBrowse: (String?) -> Unit,
) {
    val isDirectory = entry.type == "directory"
    val detail = buildList {
        if (!isDirectory) entry.size?.let { add(formatBytes(it)) }
        entry.modifiedAt?.let { add(formatTime(it)) }
    }.joinToString(" · ")

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { if (isDirectory) onBrowse(entry.path) else onOpen() }
            .padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = if (isDirectory) Icons.Rounded.Folder else Icons.Rounded.Description,
            contentDescription = null,
            tint = if (isDirectory) MaterialTheme.colorScheme.primary
            else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(22.dp),
        )
        Spacer(modifier = Modifier.width(12.dp))
        Text(
            entry.name,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (detail.isNotEmpty()) {
            Spacer(modifier = Modifier.width(8.dp))
            Text(
                detail,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
            )
        }
        if (isDirectory) {
            Spacer(modifier = Modifier.width(4.dp))
            Icon(
                imageVector = Icons.Rounded.ChevronRight,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FileContentScreen(
    state: FileContentUiState,
    onBack: () -> Unit,
    bottomOverlayPadding: Dp,
) {
    val pathKey = when (state) {
        is FileContentUiState.Loading -> state.path
        is FileContentUiState.Ready -> state.content.path
        is FileContentUiState.Error -> state.path
    }
    var wrap by remember(pathKey) { mutableStateOf(true) }
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        fileName(pathKey),
                        style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Monospace),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
                actions = {
                    TextButton(onClick = { wrap = !wrap }) {
                        Text(if (wrap) "不换行" else "自动换行")
                    }
                },
            )
        },
    ) { innerPadding ->
        when (state) {
            is FileContentUiState.Loading -> Box(
                Modifier.fillMaxSize().padding(innerPadding),
                contentAlignment = Alignment.Center,
            ) { CircularProgressIndicator() }
            is FileContentUiState.Error -> Box(
                Modifier.fillMaxSize().padding(innerPadding),
                contentAlignment = Alignment.Center,
            ) { Text(state.message, color = MaterialTheme.colorScheme.error) }
            is FileContentUiState.Ready -> {
                val content = state.content
                when {
                    content.binary -> Box(
                        Modifier.fillMaxSize().padding(innerPadding),
                        contentAlignment = Alignment.Center,
                    ) { Text("暂不支持预览二进制文件", color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    else -> {
                        val lines = remember(content.content) { content.content.split('\n') }
                        Column(modifier = Modifier.fillMaxSize().padding(innerPadding)) {
                            if (content.truncated) {
                                Text(
                                    "内容过大，已截断",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.error,
                                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                                )
                            }
                            // 深色底放在整块内容容器上：短文件时 LazyColumn 可能只占文字宽度，
                            // 右侧会露出 Scaffold 的白底。
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .weight(1f)
                                    .background(IdeBackground),
                            ) {
                                if (wrap) {
                                    LazyColumn(
                                        modifier = Modifier.fillMaxSize(),
                                        contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = bottomOverlayPadding),
                                    ) {
                                        items(lines) { line ->
                                            Text(
                                                line,
                                                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                                color = IdeText,
                                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp),
                                            )
                                        }
                                    }
                                } else {
                                    val maxChars = remember(lines) { lines.maxOfOrNull { it.length } ?: 0 }
                                    val lineWidth = remember(maxChars) { minOf(maxOf(360.dp, (maxChars * 7).dp), 3200.dp) }
                                    val horizontalState = rememberScrollState()
                                    LazyColumn(
                                        modifier = Modifier.fillMaxSize(),
                                        contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = bottomOverlayPadding),
                                    ) {
                                        items(lines) { line ->
                                            Row(modifier = Modifier.horizontalScroll(horizontalState)) {
                                                Text(
                                                    line,
                                                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                                    color = IdeText,
                                                    softWrap = false,
                                                    maxLines = 1,
                                                    modifier = Modifier.width(lineWidth).padding(horizontal = 12.dp),
                                                )
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ErrorContent(message: String, onRetry: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(message, color = MaterialTheme.colorScheme.error)
        Spacer(modifier = Modifier.height(12.dp))
        OutlinedButton(onClick = onRetry) { Text("重试") }
    }
}

@Composable
private fun EmptyHint(title: String, body: String) {
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            body,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ChangeRow(file: ChangedFileDto, onClick: () -> Unit) {
    val stats = when {
        file.binary -> "二进制"
        file.additions != null || file.deletions != null -> buildString {
            file.additions?.let { append("+$it") }
            if (file.additions != null && file.deletions != null) append(" ")
            file.deletions?.let { append("-$it") }
        }
        else -> null
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = !file.isDirectory, onClick = onClick)
            .padding(vertical = 10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            // 文件名单独一行：路径单行显示时省略号会吃掉末尾，而末尾恰恰是最该看的文件名。
            Text(
                fileName(file.path),
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Spacer(modifier = Modifier.width(6.dp))
            Text(
                statusLetter(file.status),
                style = MaterialTheme.typography.bodyMedium.copy(
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.SemiBold,
                ),
                color = statusColor(file.status),
            )
            if (file.staged) {
                Spacer(modifier = Modifier.width(6.dp))
                Text(
                    "已暂存",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
            stats?.let {
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    it,
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
            }
        }
        val directory = directoryLabel(file.path)
        if (directory != null || file.isDirectory) {
            Text(
                if (file.isDirectory) "目录${directory?.let { " · $it" } ?: ""}" else directory.orEmpty(),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun statusColor(status: String): Color = when (status) {
    "added" -> MaterialTheme.colorScheme.secondary
    "deleted", "conflicted" -> MaterialTheme.colorScheme.error
    "renamed" -> MaterialTheme.colorScheme.primary
    "untracked" -> MaterialTheme.colorScheme.onSurfaceVariant
    else -> MaterialTheme.colorScheme.tertiary
}

private fun statusLetter(status: String): String = when (status) {
    "added" -> "A"
    "deleted" -> "D"
    "renamed" -> "R"
    "untracked" -> "?"
    "conflicted" -> "U"
    else -> "M"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DiffScreen(
    state: DiffUiState,
    onBack: () -> Unit,
    onOpenFullFile: () -> Unit,
    bottomOverlayPadding: Dp,
) {
    var split by remember { mutableStateOf(true) }
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        fileName(
                            when (state) {
                                is DiffUiState.Loading -> state.path
                                is DiffUiState.Ready -> state.diff.path
                                is DiffUiState.Error -> state.path
                            },
                        ),
                        style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Monospace),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
                actions = {
                    if (state is DiffUiState.Ready) {
                        TextButton(onClick = onOpenFullFile) { Text("全文") }
                    }
                    TextButton(onClick = { split = !split }) {
                        Text(if (split) "统一" else "并排")
                    }
                },
            )
        },
    ) { innerPadding ->
        Box(
            modifier = Modifier.fillMaxSize().padding(innerPadding),
            contentAlignment = Alignment.Center,
        ) {
            when (state) {
                is DiffUiState.Loading -> CircularProgressIndicator()
                is DiffUiState.Error -> Text(
                    state.message,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(20.dp),
                )
                is DiffUiState.Ready -> DiffContent(
                    state = state,
                    split = split,
                    bottomOverlayPadding = bottomOverlayPadding,
                )
            }
        }
    }
}

@Composable
private fun DiffContent(state: DiffUiState.Ready, split: Boolean, bottomOverlayPadding: Dp) {
    val diff = state.diff
    if (diff.binary) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("暂不支持预览二进制文件", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    } else {
        Column(modifier = Modifier.fillMaxSize()) {
            if (diff.truncated) {
                Text(
                    "内容过大，已截断",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                )
            }
            if (split) {
                SplitDiffContent(diff.patch, bottomOverlayPadding)
            } else {
                UnifiedDiffContent(diff.patch, bottomOverlayPadding)
            }
        }
    }
}

@Composable
private fun UnifiedDiffContent(patch: String, bottomOverlayPadding: Dp) {
    LazyColumn(
        modifier = Modifier.fillMaxSize().background(IdeBackground),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = bottomOverlayPadding),
    ) {
        items(patch.split('\n')) { line ->
            val isHunk = line.startsWith("@@")
            Text(
                line,
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                color = diffLineColor(line),
                modifier = Modifier
                    .fillMaxWidth()
                    .background(if (isHunk) IdeHunkBackground else Color.Transparent)
                    .padding(horizontal = 12.dp, vertical = 2.dp),
            )
        }
    }
}

@Composable
private fun SplitDiffContent(patch: String, bottomOverlayPadding: Dp) {
    val rows = remember(patch) { parseSplitDiff(patch) }
    var expandedRow by remember(patch) { mutableStateOf<Int?>(null) }
    val horizontalState = rememberScrollState()
    val maxChars = remember(patch) { patch.split('\n').maxOfOrNull { it.length } ?: 0 }
    val columnWidth = remember(maxChars) { minOf(maxOf(DiffColumnWidth, (maxChars * 7).dp), 3200.dp) }
    LazyColumn(
        modifier = Modifier.fillMaxSize().background(IdeBackground),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = bottomOverlayPadding),
    ) {
        itemsIndexed(rows) { index, row ->
            when (row.kind) {
                SplitDiffKind.HUNK -> Text(
                    row.fullText.orEmpty(),
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                    color = IdeHunk,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(IdeHunkBackground)
                        .padding(horizontal = 12.dp, vertical = 4.dp),
                )
                SplitDiffKind.META -> Text(
                    row.fullText.orEmpty(),
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                    color = IdeMuted,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 2.dp),
                )
                SplitDiffKind.LINES -> {
                    val expanded = expandedRow == index
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .horizontalScroll(horizontalState)
                            .clickable { expandedRow = if (expanded) null else index }
                            .padding(vertical = 1.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        SplitDiffCell(
                            lineNumber = row.oldLineNumber,
                            text = row.oldText,
                            color = if (row.oldText != null && row.newText == null) IdeDeleted else IdeText,
                            expanded = expanded,
                            modifier = Modifier.width(columnWidth),
                        )
                        Box(
                            modifier = Modifier
                                .width(1.dp)
                                .height(18.dp)
                                .background(IdeDivider)
                                .align(Alignment.CenterVertically),
                        )
                        SplitDiffCell(
                            lineNumber = row.newLineNumber,
                            text = row.newText,
                            color = if (row.newText != null && row.oldText == null) IdeAdded else IdeText,
                            expanded = expanded,
                            modifier = Modifier.width(columnWidth),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SplitDiffCell(
    lineNumber: Int?,
    text: String?,
    color: Color,
    expanded: Boolean,
    modifier: Modifier = Modifier,
) {
    Row(modifier = modifier) {
        Text(
            lineNumber?.toString().orEmpty(),
            style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
            color = IdeMuted,
            modifier = Modifier.width(36.dp),
        )
        Text(
            text.orEmpty(),
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            color = color,
            softWrap = expanded,
            maxLines = if (expanded) Int.MAX_VALUE else 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}

private fun diffLineColor(line: String): Color = when {
    line.startsWith("+") && !line.startsWith("+++") -> IdeAdded
    line.startsWith("-") && !line.startsWith("---") -> IdeDeleted
    line.startsWith("@@") -> IdeHunk
    else -> IdeText
}

private fun fileName(path: String): String = path.substringAfterLast('/').ifBlank { path }

/**
 * 改动行的目录前缀：只保留最后 [segments] 级 —— 前面的层级各行都在重复、信息量低，
 * 层级更多时以 `…/` 开头。顶层文件返回 null（没有目录可显示）。
 */
private fun directoryLabel(path: String, segments: Int = 3): String? {
    val parts = path.substringBeforeLast('/', "").split('/').filter { it.isNotBlank() }
    if (parts.isEmpty()) return null
    val prefix = if (parts.size > segments) "…/" else ""
    return "$prefix${parts.takeLast(segments).joinToString("/")}/"
}

private val IdeBackground = Color(0xFF1E1E1E)
private val IdeHunkBackground = Color(0xFF2D2D30)
private val IdeText = Color(0xFFD4D4D4)
private val IdeMuted = Color(0xFF858585)
private val IdeAdded = Color(0xFF89D185)
private val IdeDeleted = Color(0xFFF48771)
private val IdeHunk = Color(0xFF569CD6)
private val IdeDivider = Color(0xFF3C3C3C)
private val DiffColumnWidth = 520.dp

private fun formatBytes(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> String.format("%.1f KB", bytes / 1024.0)
    else -> String.format("%.1f MB", bytes / 1024.0 / 1024.0)
}

private fun formatTime(epochMs: Long): String = java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.getDefault()).format(java.util.Date(epochMs))
