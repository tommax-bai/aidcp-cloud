-- aidcp:kind=expand
-- aidcp:objects=column:automation_sync_read_consumer_checkpoint.stream
--
-- change split-cloud-automation-production-runtime 批 E-2 步骤 2：新增同步读流
-- `facebook_operation_policy`（api 属主 → automation 消费）。
--
-- 0083 建表时把允许的流名**逐条写死在 CHECK 约束里**，那是这份名单的第四个手抄副本
-- （另三份：组装根自举名单、automation 私有组装根消费流清单、镜像类的 apply 分支）。
-- 前三份漏了会被 typecheck 或用例接住；**这一份漏了只有真连库才现形** ——
-- 实测：进程起来、拉到快照、写检查点时被约束拒掉，启动期抛错，服务起不来。
--
-- 只放宽取值域、不动数据、不动主键，故为 expand：老代码写不出新流名，新代码写得出，
-- 两个方向都安全，可与旧版本并存。
ALTER TABLE automation_sync_read_consumer_checkpoint
  DROP CONSTRAINT IF EXISTS automation_sync_read_consumer_checkpoint_stream_check;

ALTER TABLE automation_sync_read_consumer_checkpoint
  ADD CONSTRAINT automation_sync_read_consumer_checkpoint_stream_check CHECK (
    stream IN (
      'account_persona',
      'client_environment_automation',
      'automation_account_projection',
      'content_schedule',
      'hot_lead_config',
      'facebook_comment_config',
      'facebook_group_join_automation_config',
      'facebook_operation_policy'
    )
  );
