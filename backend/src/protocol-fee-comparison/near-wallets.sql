-- Dune query 8767542. start_date (inclusive) and end_date (exclusive) are ISO TEXT parameters.
-- Daily received NEAR/wNEAR, excluding transfers among the fee wallets.
WITH fee_wallets(wallet) AS (VALUES ('fefundsadmin.sputnik-dao.near'),('1csfundsadmin.sputnik-dao.near'),('buybacks.multisignature.near')),
moves AS (
 SELECT block_date AS day, receipt_receiver_account_id AS wallet, CAST(action_transfer_deposit AS DOUBLE) / 1e24 AS amount_near
 FROM near.actions
 WHERE block_date >= DATE '{{start_date}}' AND block_date < DATE '{{end_date}}'
 AND action_kind = 'TRANSFER' AND execution_status = 'SUCCESS_VALUE'
 AND receipt_receiver_account_id IN (SELECT wallet FROM fee_wallets)
 AND receipt_predecessor_account_id NOT IN (SELECT wallet FROM fee_wallets)
 UNION ALL
 SELECT block_date AS day, affected_account_id AS wallet, CAST(delta_amount AS DOUBLE) / 1e24 AS amount_near
 FROM near.ft_transfers
 WHERE block_date >= DATE '{{start_date}}' AND block_date < DATE '{{end_date}}'
 AND contract_account_id = 'wrap.near' AND delta_amount > 0
 AND affected_account_id IN (SELECT wallet FROM fee_wallets)
 AND (involved_account_id IS NULL OR involved_account_id NOT IN (SELECT wallet FROM fee_wallets))
)
SELECT day, SUM(CASE WHEN wallet='fefundsadmin.sputnik-dao.near' THEN amount_near ELSE 0 END) AS frontend_near,
SUM(CASE WHEN wallet<>'fefundsadmin.sputnik-dao.near' THEN amount_near ELSE 0 END) AS other_near
FROM moves GROUP BY 1 ORDER BY 1
